import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { applyCache, applyLastMessageCache } from "../domain/context.js";
import { createLogger, truncateString, truncateValue } from "./logger.js";
import { inc } from "./metrics.js";

const logger = createLogger("provider");

const MAX_RETRIES = Number(process.env.PROVIDER_MAX_RETRIES ?? 3);
const RETRY_BASE_MS = Number(process.env.PROVIDER_RETRY_BASE_MS ?? 1000);
const RETRY_MAX_DELAY_MS = Number(process.env.PROVIDER_RETRY_MAX_DELAY_MS ?? 30_000);

// Decide whether an error is worth retrying. Structured fields (status / type) take
// precedence; message-substring matching is a last-resort fallback for proxies that only
// surface the reason in text. Retries cover: rate limits, transient upstream/network
// blips, and ALL 5xx (the proxy/upstream channel is sometimes flaky and recovers).
export function isRetryableError(error: any): boolean {
  // HTTP status: 429 (rate limit) + any 5xx (502/503/504 from the proxy or upstream).
  const status: number | undefined = error?.status ?? error?.statusCode;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;

  // Anthropic SDK structured error types.
  const type: string | undefined = error?.type ?? error?.error?.type;
  if (type === "rate_limit_error" || type === "overloaded_error" ||
      type === "api_error" || type === "upstream_error") return true;

  // Transient network errors (no HTTP response at all).
  const code: string | undefined = error?.code ?? error?.cause?.code;
  if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;

  // Last-resort message matching (proxy text without structured fields).
  const msg: string = error?.message ?? "";
  return /rate limit|Upstream request failed|Concurrency limit|overloaded|timeout|temporarily unavailable|503|502|504/i.test(msg);
}

// Parse an HTTP Retry-After header: either delta-seconds or an HTTP-date. Returns ms, or
// undefined if unparseable. Negative/past values clamp to 0.
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// Exponential backoff with full jitter, honoring Retry-After when the server provides it.
// jitter avoids the thundering-herd problem when many concurrent requests are throttled
// together and would otherwise all wake at the same instant and re-collide.
export function computeRetryDelay(attempt: number, retryAfterMs?: number): number {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_MS * Math.pow(2, attempt));
  const jittered = Math.random() * exp; // full jitter: uniform in [0, exp]
  // If the server told us how long to wait, never wait less than that.
  return retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered;
}

async function withRetry<T>(fn: () => Promise<T>, context: Record<string, unknown>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_RETRIES) { inc("provider.errors"); throw error; }
      const delay = Math.round(computeRetryDelay(attempt, error?.retryAfterMs));
      logger.warn("provider_retry", { attempt: attempt + 1, maxRetries: MAX_RETRIES, delayMs: delay, status: error?.status, type: error?.type, code: error?.code, error: error?.message, ...context });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export type ProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
};

export interface Provider {
  readonly type: "anthropic" | "openai";
  readonly model: string;
  readonly contextWindow: number;
  stream(params: {
    systemPrompt: string;
    systemSuffix?: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    onText: (delta: string) => void;
    sessionId?: string;
  }): Promise<{
    stopReason: string;
    content: Anthropic.ContentBlock[];
    usage?: TokenUsage;
    abort?: () => void;
  }>;
}

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// ── Anthropic provider ────────────────────────────────────────────────────────

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const client = new Anthropic({
    authToken: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: {
      "user-agent": "claude-cli/2.1.121 (external, sdk-cli)",
      "x-app": "cli",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,effort-2025-11-24",
      // Claude Code identifier. Kept STATIC (no per-request fields) on purpose: a value
      // that changes each request defeats the upstream prompt cache. X-Stainless-* headers
      // (lang/os/arch/runtime/version) are auto-injected by the SDK, so not set here.
      "x-anthropic-billing-header": "cc_version=2.1.121; cc_entrypoint=cli",
    },
  });
  const model = config.model ?? "claude-opus-4-7";
  const maxTokens = config.maxTokens ?? 64000;

  return {
    type: "anthropic",
    model,
    contextWindow: getAnthropicContextWindow(model),
    async stream({ systemPrompt, systemSuffix, messages, tools, onText, sessionId }) {
      const context = () => ({
        providerType: "anthropic",
        model,
        messageCount: messages.length,
        tools: tools.map((t) => t.name),
        messageSummary: summarizeAnthropicMessages(messages),
      });

      return withRetry(async () => {
        try {
          // systemSuffix (per-turn dynamic content) must NOT go into a 2nd system block:
          // the system section sits BEFORE messages in Anthropic's cache prefix, so a
          // per-turn-varying block there kills the message cache read every turn (proven:
          // cache_read stayed 0 across turns). Instead it rides at the tail of the last
          // user message, AFTER the rolling breakpoint — see applyLastMessageCache.
          const systemBlocks: any[] = [
            { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
          ];

          const s = client.messages.stream({
          model,
          max_tokens: maxTokens,
          // Explicit rolling breakpoint on the LAST message. Probing this endpoint (Bedrock
          // via code.casstime.ai) showed top-level cache_control is IGNORED here — only
          // explicit breakpoints create cache. Without this, conversation history never
          // enters the cache (cache_creation stays 0) and every turn re-bills the full
          // history past the tools breakpoint. system + tools + last-message = 3 of the
          // 4 allowed breakpoints.
          system: systemBlocks,
          tools: applyCache(tools),
          messages: applyLastMessageCache(messages, systemSuffix),
          thinking: { type: "adaptive" },
          // user_id groups requests by end-user for Anthropic's abuse monitoring (best
          // practice). It does NOT affect prefix caching. Uses the no-PII session uuid.
          ...(sessionId ? { metadata: { user_id: sessionId } } : {}),
        } as any);

        s.on("text", onText);
        const msg = await s.finalMessage();
        const usage: TokenUsage = {
          input_tokens: (msg.usage as any).input_tokens ?? 0,
          output_tokens: (msg.usage as any).output_tokens ?? 0,
          cache_creation_input_tokens: (msg.usage as any).cache_creation_input_tokens,
          cache_read_input_tokens: (msg.usage as any).cache_read_input_tokens,
        };
        inc("tokens.input", usage.input_tokens);
        inc("tokens.output", usage.output_tokens);
        inc("provider.requests");
        logger.info("anthropic.usage", {
          model,
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreate: usage.cache_creation_input_tokens ?? 0,
          hitRatio: Number(((usage.cache_read_input_tokens ?? 0) / Math.max(1, usage.input_tokens + (usage.cache_read_input_tokens ?? 0))).toFixed(3)),
        });
        return { stopReason: msg.stop_reason ?? "end_turn", content: msg.content as any, usage, abort: () => (s as any).abort?.() };
        } catch (error) {
          logger.error("anthropic.stream_exception", error, context());
          throw error;
        }
      }, { providerType: "anthropic", model });
    },
  };
}

// ── OpenAI Responses API provider ────────────────────────────────────────────
// Uses /v1/responses (stateless mode, full history in input[]).
// Compatible with any OpenAI-format endpoint that supports the Responses API.

export function createOpenAIProvider(config: ProviderConfig): Provider {
  let baseURL = config.baseURL ?? "https://api.openai.com/v1";
  if (baseURL && !baseURL.endsWith("/v1") && !baseURL.endsWith("/v1/")) {
    baseURL = baseURL.replace(/\/$/, "") + "/v1";
  }
  const client = new OpenAI({ apiKey: config.apiKey, baseURL });
  const model = config.model ?? "gpt-4o";
  const maxOutputTokens = config.maxTokens ?? 16000;

  return {
    type: "openai",
    model,
    contextWindow: getOpenAIContextWindow(model),
    async stream({ systemPrompt, systemSuffix, messages, tools, onText, sessionId }) {
      const input = buildResponsesInput(systemSuffix, messages);
      const responsesTools = buildResponsesTools(tools);

      logger.debug("openai.responses.input", {
        providerType: "openai",
        model,
        inputItems: input.length,
        toolCount: responsesTools.length,
        inputSummary: summarizeResponsesInput(input),
      });

      return withRetry(async () => {
        try {
        // Use raw fetch instead of SDK's responses.stream() — the SDK crashes when
        // response.completed has output:null (non-standard behavior of this endpoint)
        const baseURLForFetch = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
        const res = await fetch(`${baseURLForFetch}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey ?? ""}`,
          },
          body: JSON.stringify({
            model,
            // instructions holds ONLY the static system prompt. Dynamic content (date,
            // memory) goes to the END of input via buildResponsesInput, because this
            // endpoint folds instructions into the cache-prefix — putting the daily date
            // here punctures the whole prefix every day. Verified by probing the endpoint:
            // mutating the instructions tail dropped cached_tokens from full to partial.
            instructions: systemPrompt,
            input: input,
            tools: responsesTools.length > 0 ? responsesTools : undefined,
            max_output_tokens: maxOutputTokens,
            // Stable per-session key: routes a session's requests to the same cache shard
            // (OpenAI best practice). Constant across a session's turns, distinct per session.
            prompt_cache_key: sessionId || undefined,
            stream: true,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          const err = new Error(`Responses API error ${res.status}: ${errText}`) as any;
          // Structured fields so withRetry can decide without parsing the message string.
          err.status = res.status;
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) err.retryAfterMs = parseRetryAfter(retryAfter);
          throw err;
        }

        const content: Anthropic.ContentBlock[] = [];
        let textBuffer = "";
        const toolCalls: Record<string, { id: string; name: string; args: string }> = {};
        let stopReason = "end_turn";
        let usage: TokenUsage | undefined;

        try {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw || raw === "[DONE]") continue;

              let event: any;
              try { event = JSON.parse(raw); } catch { continue; }

              const type = event.type as string;

              if (type === "response.output_text.delta") {
                const delta = event.delta as string;
                textBuffer += delta;
                onText(delta);
              } else if (type === "response.output_item.added") {
                const item = event.item as any;
                if (item?.type === "function_call") {
                  toolCalls[item.call_id] = { id: item.call_id, name: item.name, args: "" };
                }
              } else if (type === "response.function_call_arguments.delta") {
                const callId = event.call_id as string;
                if (toolCalls[callId]) toolCalls[callId].args += event.delta as string;
              } else if (type === "response.output_item.done") {
                const item = event.item as any;
                if (item?.type === "function_call") {
                  toolCalls[item.call_id] = { id: item.call_id, name: item.name, args: item.arguments ?? "" };
                  stopReason = "tool_use";
                }
              } else if (type === "response.completed") {
                const response = event.response as any;
                const status = response?.status as string;
                if (status === "incomplete") stopReason = "max_tokens";
                else if (stopReason !== "tool_use") stopReason = "end_turn";
                const u = response?.usage;
                if (u) {
                  usage = {
                    input_tokens: u.input_tokens ?? 0,
                    output_tokens: u.output_tokens ?? 0,
                    cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
                  };
                  inc("tokens.input", usage.input_tokens);
                  inc("tokens.output", usage.output_tokens);
                  inc("provider.requests");
                }
                logger.info("openai.responses.completed", { model, status, stopReason, input_used: usage?.input_tokens, output_used: usage?.output_tokens, cached: usage?.cache_read_input_tokens });
              }
            }
          }
        } catch (error) {
          logger.error("openai.responses.stream_iteration_exception", error, {
            providerType: "openai", model, stopReason,
            textLength: textBuffer.length,
            partialToolCalls: Object.values(toolCalls).map(tc => ({ id: tc.id, name: tc.name, argsLength: tc.args.length })),
          });
          throw error;
        }

        if (textBuffer) content.push({ type: "text", text: textBuffer, citations: [] } as any);
        for (const tc of Object.values(toolCalls)) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.args);
          } catch (error) {
            logger.warn("openai.responses.tool_args_json_parse_failed", {
              model, toolCallId: tc.id, toolName: tc.name,
              argsLength: tc.args.length, argsPreview: truncateString(tc.args, 1000),
              error: error instanceof Error ? error.message : String(error),
            });
            input = { raw: tc.args };
          }
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input } as any);
        }

        return { stopReason, content, usage };
        } catch (error) {
          logger.error("openai.responses.stream_exception", error, {
            providerType: "openai", model, inputItems: input.length, toolCount: responsesTools.length,
          });
          throw error;
        }
      }, { providerType: "openai", model });
    },
  };
}

// Convert Anthropic MessageParam[] to Responses API input items.
// Tool calls and tool results are top-level items (not wrapped in role messages).
export function buildResponsesInput(
  systemSuffix: string | undefined,
  messages: Anthropic.MessageParam[]
): unknown[] {
  const items: unknown[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      items.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const blocks = msg.content as any[];

    if (msg.role === "user") {
      const toolResults = blocks.filter(b => b.type === "tool_result");
      const textBlocks = blocks.filter(b => b.type === "text");

      for (const tr of toolResults) {
        items.push({
          type: "function_call_output",
          call_id: tr.tool_use_id,
          output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        });
      }
      if (textBlocks.length > 0) {
        const text = textBlocks.map(b => b.text).join("");
        if (text) items.push({ role: "user", content: text });
      }
    } else {
      // assistant
      const textBlocks = blocks.filter(b => b.type === "text");
      const toolUseBlocks = blocks.filter(b => b.type === "tool_use");

      if (textBlocks.length > 0) {
        const text = textBlocks.map(b => b.text).join("");
        if (text) items.push({ role: "assistant", content: text });
      }
      for (const tu of toolUseBlocks) {
        items.push({
          type: "function_call",
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input ?? {}),
        });
      }
    }
  }

  // Dynamic per-turn context (memory, date, cwd) is appended at the TAIL of input so it
  // sits after the stable prefix (instructions + history) and never invalidates the
  // cache. The last item the model sees is still the live turn context.
  if (systemSuffix) {
    items.push({ role: "user", content: systemSuffix });
  }

  return items;
}

function buildResponsesTools(tools: Anthropic.Tool[]) {
  return tools.map(t => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema,
  }));
}

function summarizeResponsesInput(items: unknown[]) {
  return (items as any[]).map((item, i) => {
    const type = item.type ?? item.role;
    if (item.type === "function_call") return { i, type, name: item.name, call_id: item.call_id };
    if (item.type === "function_call_output") return { i, type, call_id: item.call_id, outputLen: String(item.output ?? "").length };
    if (item.role) return { i, type, contentLen: String(item.content ?? "").length };
    return { i, type };
  });
}

// ── Context window lookup ─────────────────────────────────────────────────────

function getAnthropicContextWindow(model: string): number {
  if (model.includes("1m") || model.includes("opus-4")) return 1_000_000;
  if (model.includes("sonnet-4") || model.includes("haiku-4")) return 200_000;
  if (model.includes("opus-3-5") || model.includes("sonnet-3-5")) return 200_000;
  if (model.includes("haiku-3")) return 200_000;
  return 200_000;
}

function getOpenAIContextWindow(model: string): number {
  if (model.includes("gpt-5")) return 400_000;
  if (model.includes("gpt-4o")) return 128_000;
  if (model.includes("gpt-4-turbo")) return 128_000;
  if (model.includes("gpt-4")) return 8_192;
  if (model.includes("gpt-3.5-turbo-16k")) return 16_384;
  if (model.includes("gpt-3.5")) return 4_096;
  if (model.includes("deepseek")) return 64_000;
  if (model.includes("qwen")) return 128_000;
  return 128_000;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createProvider(config: ProviderConfig & { type?: "anthropic" | "openai" }): Provider {
  const type = config.type ?? (config.baseURL?.includes("anthropic") || !config.baseURL ? "anthropic" : "openai");
  return type === "openai" ? createOpenAIProvider(config) : createAnthropicProvider(config);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function summarizeAnthropicMessages(messages: Anthropic.MessageParam[]) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    content: summarizeAnthropicContent(message.content),
  }));
}

function summarizeAnthropicContent(content: Anthropic.MessageParam["content"]) {
  if (typeof content === "string") return { type: "text", length: content.length };
  if (!Array.isArray(content)) return { type: typeof content };
  return content.map((block: any) => {
    if (block.type === "text") return { type: "text", length: block.text?.length ?? 0 };
    if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: truncateValue(block.input, 500) };
    if (block.type === "tool_result") return { type: "tool_result", tool_use_id: block.tool_use_id, is_error: block.is_error, content: truncateValue(block.content, 500) };
    return { type: block.type ?? typeof block };
  });
}

// ── Model list ────────────────────────────────────────────────────────────────

export async function fetchModels(config: { type?: string; apiKey?: string; baseURL?: string }): Promise<string[]> {
  const type = config.type ?? "anthropic";
  const headers: Record<string, string> = {};

  if (type === "anthropic") {
    const baseURL = config.baseURL ?? "https://api.anthropic.com";
    if (config.apiKey) headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["user-agent"] = "claude-cli/2.1.121 (external, sdk-cli)";
    headers["x-app"] = "cli";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    try {
      const res = await fetch(`${baseURL}/v1/models`, { headers });
      const json = await res.json() as any;
      return (json.data ?? []).map((m: any) => m.id).filter(Boolean);
    } catch (error) {
      logger.warn("anthropic.fetch_models_failed", { baseURL, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  } else {
    const baseURL = config.baseURL ?? "https://api.openai.com/v1";
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    try {
      const res = await fetch(`${baseURL}/models`, { headers });
      const json = await res.json() as any;
      return (json.data ?? []).map((m: any) => m.id).filter(Boolean).sort();
    } catch (error) {
      logger.warn("openai.fetch_models_failed", { baseURL, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }
}
