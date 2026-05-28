import type Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "../tools/index.js";
import { browserTools, executeBrowserTool } from "../tools/browser.js";
import { getMcpTools, callMcpTool, mcpToolMap } from "../infra/mcp.js";
import { prepareMessages } from "./context.js";
import { saveMessage, repairSessionMessages, updateSessionStatus, rewriteSessionMessages } from "../infra/session.js";
import { fireHook } from "../infra/hooks.js";
import { inc } from "../infra/metrics.js";
import type { SessionState } from "./types.js";
import type { Provider, TokenUsage } from "../infra/provider.js";
import { startTrace, finalizeTrace, addErrorEvent, type Trace } from "../infra/trace.js";
import { createLogger, serializeError, truncateValue } from "../infra/logger.js";
import { memoryTools, executeMemoryTool, retrieveForSystem, retrieveForMessages, extractMemories } from "../memory/index.js";

const MAX_ITERATIONS = Number(process.env.MAX_AGENT_ITERATIONS ?? 50);
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS ?? 5 * 60 * 1000); // 5 min default
const logger = createLogger("agent");

function withToolTimeout<T>(promise: Promise<T>, toolName: string, sessionId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool timeout after ${TOOL_TIMEOUT_MS}ms: ${toolName}`));
      logger.error("tool_timeout", new Error(`Tool timeout`), { sessionId, toolName, timeoutMs: TOOL_TIMEOUT_MS });
    }, TOOL_TIMEOUT_MS);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: string; is_error: boolean }
  | { type: "done"; traceId: string; usage: TokenUsage }
  | { type: "error"; message: string };

export type AgentOptions = {
  provider: Provider;
  systemPrompt: string;
  onEvent: (event: AgentEvent) => void;
  maxIterations?: number;
  allowedTools?: string[];
};

export async function runAgent(state: SessionState, opts: AgentOptions) {
  const { provider, systemPrompt, onEvent } = opts;
  const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
  let allTools: Anthropic.Tool[] = [];
  let trace: Trace | undefined;
  let loopMessages: Anthropic.MessageParam[] = [];
  let phase = "init";
  let iteration = -1;
  let currentToolName: string | undefined;
  let userMessage = "";
  const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  try {
    inc("agent.runs");
    phase = "load_tools";
    const allToolsRaw = [...tools, ...browserTools, ...memoryTools, ...getMcpTools()];
    allTools = opts.allowedTools
      ? allToolsRaw.filter(t => opts.allowedTools!.some(pattern =>
          pattern.endsWith("*") ? t.name.startsWith(pattern.slice(0, -1)) : t.name === pattern
        ))
      : allToolsRaw;

    phase = "repair_messages";
    repairSessionMessages(state);

    userMessage = typeof state.messages.at(-1)?.content === "string"
      ? state.messages.at(-1)!.content as string
      : "";

    phase = "start_trace";
    trace = startTrace(state.id, userMessage, provider.model);

    phase = "prepare_messages";
    fireHook("before_message", { SESSION_ID: state.id, MESSAGE: userMessage });
    const prepareResult = await prepareMessages(state.messages, state.lastInputTokens);
    loopMessages = prepareResult.messages;
    if (prepareResult.persistBack) {
      state.messages = prepareResult.messages;
      rewriteSessionMessages(state.id, state.messages);
      state.lastInputTokens = undefined;
    }

    phase = "retrieve_core_memory";
    const coreMemory = await retrieveForSystem();

    // Dynamic context: cwd, date — injected per-provider to preserve cache stability
    const dynamicContext = `工作目录：${state.cwd}\n日期：${new Date().toISOString().split("T")[0]}\n系统：${process.platform}`;

    // instructions = system prompt + stable dynamic context (core memory, env)
    // These change rarely (only when memory is updated or cwd changes)
    const memorySuffix = coreMemory
      ? `\n<user_memory>\n${coreMemory}\n</user_memory>\n<context>\n${dynamicContext}\n</context>`
      : `\n<context>\n${dynamicContext}\n</context>`;

    phase = "retrieve_context_memory";
    let contextMemory = "";
    if (userMessage) {
      contextMemory = await retrieveForMessages(userMessage);
    }

    // contextMemory is per-message (changes every request) — append to the last user message content
    // This only changes the LAST item in the input array, preserving the prefix for caching
    if (contextMemory && loopMessages.length > 0) {
      const lastMsg = loopMessages[loopMessages.length - 1];
      if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
        loopMessages[loopMessages.length - 1] = {
          ...lastMsg,
          content: `${lastMsg.content}\n\n[相关记忆]\n${contextMemory}`,
        };
      }
    }

    for (iteration = 0; iteration < maxIter; iteration++) {
      phase = "iteration_start";
      if (!state.running) break;

      logger.debug("loop.messages", {
        sessionId: state.id,
        traceId: trace.id,
        iteration,
        messages: summarizeMessages(loopMessages),
      });

      phase = "trace_llm_call";
      trace.events.push({ type: "llm_call", iteration, model: provider.model, systemPrompt, messages: summarizeMessages(loopMessages), ts: Date.now() });

      phase = "provider_stream";
      updateSessionStatus(state.id, { running: true, currentPhase: "thinking", currentTool: undefined, startedAt: trace.startTs });
      const { stopReason, content, usage, abort } = await provider.stream({
        systemPrompt,
        systemSuffix: memorySuffix || undefined,
        messages: loopMessages,
        tools: allTools,
        onText: (delta) => onEvent({ type: "text", delta }),
      });

      phase = "post_stream_running_check";
      if (!state.running) break;

      phase = "accumulate_usage";
      if (usage) {
        totalUsage.input_tokens += usage.input_tokens;
        totalUsage.output_tokens += usage.output_tokens;
        totalUsage.cache_creation_input_tokens! += usage.cache_creation_input_tokens ?? 0;
        totalUsage.cache_read_input_tokens! += usage.cache_read_input_tokens ?? 0;
        state.lastInputTokens = usage.input_tokens;
      }

      phase = "save_assistant_message";
      state.currentStream = { abort };
      const storedContent = content.filter((b) => b.type !== "thinking");
      // Use a placeholder for empty responses to preserve cache prefix stability
      const persistContent = storedContent.length > 0
        ? storedContent
        : [{ type: "text", text: "" }] as any[];
      state.messages.push({ role: "assistant", content: persistContent as any });
      saveMessage(state.id, "assistant", persistContent);
      loopMessages = [...loopMessages, { role: "assistant" as const, content: storedContent as any }];

      phase = "trace_llm_response";
      trace.events.push({ type: "llm_response", iteration, stopReason, content, usage, ts: Date.now() });

      if (stopReason === "end_turn") {
        phase = "finalize_done";
        updateSessionStatus(state.id, { running: false, currentTool: undefined, currentPhase: undefined, messageCount: state.messages.length });
        trace.endTs = Date.now();
        trace.events.push({ type: "done", totalMs: trace.endTs - trace.startTs, totalUsage, ts: Date.now() });
        safeFinalizeTrace(trace, { sessionId: state.id, phase, iteration });
        onEvent({ type: "done", traceId: trace.id, usage: totalUsage });
        const assistantText = content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
        fireHook("on_done", {
          SESSION_ID: state.id,
          RESPONSE_TEXT: assistantText,
          USAGE: JSON.stringify(totalUsage),
        });
        if (userMessage && assistantText) {
          extractMemories(userMessage, assistantText, state.id).catch((error) => {
            logger.error("memory_extract.background_exception", error, { sessionId: state.id, traceId: trace?.id });
          });
        }
        return;
      }

      if (stopReason === "pause_turn" || stopReason === "max_tokens") continue;

      phase = "extract_tool_uses";
      const toolUses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        const msg = `Stopped with ${stopReason} but no tool_use block.`;
        trace.endTs = Date.now();
        addErrorEvent(trace, msg, { phase, details: { stopReason, contentSummary: summarizeContentBlocks(content) } });
        safeFinalizeTrace(trace, { sessionId: state.id, phase, iteration });
        onEvent({ type: "error", message: msg });
        return;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        phase = "tool_start";
        currentToolName = toolUse.name;
        if (!state.running) {
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Interrupted", is_error: true });
          continue;
        }
        onEvent({ type: "tool_use", name: toolUse.name, input: toolUse.input });
        trace.events.push({ type: "tool_call", name: toolUse.name, input: toolUse.input, ts: Date.now() });

        phase = "tool_dispatch";
        updateSessionStatus(state.id, { currentTool: toolUse.name, currentPhase: "tool_executing" });
        const t0 = Date.now();
        let result: { content: string; is_error?: boolean };
        try {
          result = await withToolTimeout(
            mcpToolMap.has(toolUse.name)
              ? callMcpTool(toolUse.name, toolUse.input as Record<string, unknown>)
              : toolUse.name.startsWith("browser_")
              ? executeBrowserTool(state, toolUse.name, toolUse.input)
              : toolUse.name.startsWith("memory_")
              ? Promise.resolve(executeMemoryTool(toolUse.name, toolUse.input as Record<string, any>))
              : executeTool(state, toolUse.name, toolUse.input),
            toolUse.name,
            state.id
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("tool_dispatch_exception", error, { sessionId: state.id, toolName: toolUse.name, toolUseId: toolUse.id });
          result = { content: `Tool error: ${message}`, is_error: true };
          inc("tool.errors");
        }
        inc("tool.calls");
        const durationMs = Date.now() - t0;

        phase = "tool_result";
        const truncated = result.content.length > 4000 ? result.content.slice(0, 4000) + "\n...[truncated]" : result.content;
        onEvent({ type: "tool_result", name: toolUse.name, result: truncated, is_error: result.is_error ?? false });
        trace.events.push({ type: "tool_result", name: toolUse.name, result: truncated, is_error: result.is_error ?? false, durationMs, ts: Date.now() });
        fireHook("after_tool", {
          SESSION_ID: state.id,
          TOOL_NAME: toolUse.name,
          TOOL_INPUT: JSON.stringify(toolUse.input),
          TOOL_RESULT: truncated,
          IS_ERROR: String(result.is_error ?? false),
        });

        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result.content, is_error: result.is_error });
        currentToolName = undefined;
        updateSessionStatus(state.id, { currentTool: undefined, currentPhase: "thinking" });
      }

      phase = "save_tool_results";
      state.messages.push({ role: "user", content: toolResults });
      saveMessage(state.id, "user", toolResults);
      loopMessages = [...loopMessages, { role: "user" as const, content: toolResults as any }];
    }

    phase = "finalize_loop";
    trace.endTs = Date.now();
    if (!state.running) {
      trace.events.push({ type: "done", totalMs: trace.endTs - trace.startTs, totalUsage, ts: Date.now() });
      safeFinalizeTrace(trace, { sessionId: state.id, phase, iteration });
      onEvent({ type: "done", traceId: trace.id, usage: totalUsage });
    } else {
      const msg = `Reached MAX_ITERATIONS=${maxIter}`;
      addErrorEvent(trace, msg, { phase, details: { maxIterations: MAX_ITERATIONS } });
      safeFinalizeTrace(trace, { sessionId: state.id, phase, iteration });
      onEvent({ type: "error", message: msg });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const context = {
      sessionId: state.id,
      traceId: trace?.id,
      phase,
      iteration: iteration >= 0 ? iteration : undefined,
      currentToolName,
      providerType: provider.type,
      model: provider.model,
      stateMessageCount: state.messages.length,
      loopMessageCount: loopMessages.length,
      loopMessages: summarizeMessages(loopMessages),
      toolCount: allTools.length,
      userMessageLength: userMessage.length,
      running: state.running,
    };

    logger.error("run.exception", error, context);
    fireHook("on_error", { SESSION_ID: state.id, ERROR: message });
    if (trace) {
      trace.endTs = Date.now();
      addErrorEvent(trace, message, {
        phase,
        details: { context, error: serializeError(error) },
        stack: error instanceof Error ? error.stack : undefined,
      });
      safeFinalizeTrace(trace, context);
    }
    // Ensure any pending tool_use in state.messages has a matching tool_result
    // so the session is not left in a broken state for the next request
    repairSessionMessages(state);
    updateSessionStatus(state.id, { running: false, currentTool: undefined, currentPhase: undefined, messageCount: state.messages.length });
  }
}

function safeFinalizeTrace(trace: Trace, context: Record<string, unknown>) {
  try {
    finalizeTrace(trace);
  } catch (error) {
    logger.error("trace.finalize_exception", error, { ...context, traceId: trace.id, eventCount: trace.events.length });
  }
}

function summarizeMessages(messages: Anthropic.MessageParam[]) {
  return messages.map((m, i) => ({ index: i, role: m.role, content: summarizeMessageContent(m.content) }));
}

function summarizeMessageContent(content: Anthropic.MessageParam["content"]) {
  if (typeof content === "string") return { type: "text", length: content.length };
  if (!Array.isArray(content)) return { type: typeof content };
  return {
    blocks: content.map((b: any) => summarizeBlock(b)),
    toolUseCount: content.filter((b: any) => b.type === "tool_use").length,
    toolResultCount: content.filter((b: any) => b.type === "tool_result").length,
  };
}

function summarizeContentBlocks(content: Anthropic.ContentBlock[]) {
  return content.map((b: any) => summarizeBlock(b));
}

function summarizeBlock(block: any) {
  if (!block || typeof block !== "object") return { type: typeof block };
  if (block.type === "text") return { type: "text", length: block.text?.length ?? 0 };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: truncateValue(block.input, 1000) };
  if (block.type === "tool_result") return { type: "tool_result", tool_use_id: block.tool_use_id, is_error: block.is_error, content: truncateValue(block.content, 1000) };
  return { type: block.type ?? typeof block };
}

export function interruptAgent(state: SessionState) {
  state.currentStream?.abort?.();
  for (const child of state.activeChildren) (child as any).kill?.("SIGTERM");
  state.activeChildren.clear();
  state.running = false;
}
