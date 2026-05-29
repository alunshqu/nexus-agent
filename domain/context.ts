import type Anthropic from "@anthropic-ai/sdk";
import { createProvider } from "../infra/provider.js";
import { agentConfig } from "../infra/config.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("context");

const SUMMARY_MODEL = process.env.SUMMARY_MODEL;

// Source-level truncation: last-resort guard, should rarely trigger if tool-layer limits are set correctly
const SOURCE_TRUNCATE_LIMIT = Number(process.env.SOURCE_TRUNCATE_LIMIT ?? 20000);

export function truncateToolOutput(output: string): string {
  if (output.length <= SOURCE_TRUNCATE_LIMIT) return output;
  const headSize = Math.floor(SOURCE_TRUNCATE_LIMIT * 0.7);
  const tailSize = SOURCE_TRUNCATE_LIMIT - headSize - 100;
  return `${output.slice(0, headSize)}\n\n... [${output.length - headSize - tailSize} chars omitted] ...\n\n${output.slice(-tailSize)}`;
}

export function estimateTokens(msg: Anthropic.MessageParam): number {
  if (typeof msg.content === "string") return Math.ceil(msg.content.length / 3);
  if (Array.isArray(msg.content)) {
    return (msg.content as any[]).reduce((sum: number, b: any) => {
      if (b.type === "text") return sum + Math.ceil((b.text?.length ?? 0) / 3);
      if (b.type === "tool_use") return sum + Math.ceil(JSON.stringify(b.input ?? {}).length / 3) + 20;
      if (b.type === "tool_result") return sum + Math.ceil((typeof b.content === "string" ? b.content.length : JSON.stringify(b.content).length) / 3);
      if (b.type === "thinking") return sum + Math.ceil((b.thinking?.length ?? 0) / 3);
      return sum + 10;
    }, 0);
  }
  return 10;
}

function totalTokens(messages: Anthropic.MessageParam[]): number {
  return messages.reduce((s, m) => s + estimateTokens(m), 0);
}

// ── Three-tier context management ─────────────────────────────────────────────
// Tier 1 (50% context): Observation masking — zero LLM cost, write back
// Tier 2 (70% context): LLM summarization of old prefix, write back
// Tier 3 (90% context): Hard drop of oldest message pairs, write back
//
// Trigger: actual input_tokens from last API call (accurate) or estimated (first call)
// All tiers write back to state.messages so compression is never repeated.

export type PrepareResult = { messages: Anthropic.MessageParam[]; persistBack: boolean };

export async function prepareMessages(
  messages: Anthropic.MessageParam[],
  actualInputTokens?: number
): Promise<PrepareResult> {
  if (messages.length <= 4) return { messages, persistBack: false };

  const contextWindow = agentConfig.provider.contextWindow;
  const providerType = agentConfig.provider.type;

  // Anthropic: prompt caching is valuable — compress later to avoid cache invalidation
  // OpenAI-compatible: no persistent cache — compress earlier to keep context lean
  const tier1 = providerType === "anthropic" ? contextWindow * 0.7 : contextWindow * 0.5;
  const tier2 = providerType === "anthropic" ? contextWindow * 0.85 : contextWindow * 0.7;
  const tier3 = providerType === "anthropic" ? contextWindow * 0.95 : contextWindow * 0.9;

  const total = actualInputTokens ?? totalTokens(messages);
  if (total <= tier1) return { messages, persistBack: false };

  const msgTokens = totalTokens(messages);
  const overhead = actualInputTokens ? Math.max(0, actualInputTokens - msgTokens) : 0;

  // Tier 1: Observation masking — keep last 10 tool results, mask older ones
  let result = applyObservationMasking(messages, 10);
  let est = overhead + totalTokens(result);
  if (est <= tier2) {
    logger.info("context_compressed", {
      tier: 1,
      providerType,
      before: messages.length,
      after: result.length,
      beforeTokens: total,
      afterTokens: est,
      savedTokens: total - est,
      overhead,
      contextWindow,
    });
    return { messages: result, persistBack: true };
  }

  // Tier 2: LLM summarization of old prefix
  const recentCount = Math.min(20, Math.floor(result.length / 2));
  const prefix = result.slice(0, -recentCount);
  const recent = result.slice(-recentCount);
  const compressedPrefix = await summarizePrefix(prefix);
  result = [...compressedPrefix, ...recent];
  est = overhead + totalTokens(result);

  // Tier 3: Hard drop if still over limit
  let didHardDrop = false;
  while (est > tier3 && result.length > recentCount + 2) {
    est -= estimateTokens(result[0]);
    result.shift();
    didHardDrop = true;
    if (result[0]?.role === "assistant") { est -= estimateTokens(result[0]); result.shift(); }
  }

  if (result[0]?.role === "assistant") result.shift();
  result = removeOrphanToolMessages(result);
  result = repairSequence(result);

  logger.info("context_compressed", {
    tier: didHardDrop ? 3 : 2,
    providerType,
    before: messages.length,
    after: result.length,
    beforeTokens: total,
    afterTokens: est,
    savedTokens: total - est,
    overhead,
    contextWindow,
  });
  return { messages: result, persistBack: true };
}

function repairSequence(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Merge consecutive same-role messages (combine content arrays)
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (out.length > 0 && out[out.length - 1].role === msg.role) {
      const prev = out[out.length - 1];
      // Merge content arrays
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content as string }];
      const curContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content as string }];
      out[out.length - 1] = { ...prev, content: [...prevContent, ...curContent] as any };
    } else {
      out.push(msg);
    }
  }
  // Must start with user
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}

function removeOrphanToolMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Iteratively remove unpaired tool_use/tool_result until stable
  let prev = messages;
  for (let pass = 0; pass < 10; pass++) {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of prev) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content as any[]) if (b.type === "tool_use") toolUseIds.add(b.id);
      }
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const b of msg.content as any[]) if (b.type === "tool_result") toolResultIds.add(b.tool_use_id);
      }
    }
    const next = prev.map(msg => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const blocks = (msg.content as any[]).filter(b => b.type !== "tool_use" || toolResultIds.has(b.id));
        if (blocks.length === msg.content.length) return msg;
        if (blocks.length === 0 || blocks.every((b: any) => b.type === "thinking")) return null;
        return { ...msg, content: blocks };
      }
      if (msg.role === "user" && Array.isArray(msg.content) && (msg.content as any[]).some(b => b.type === "tool_result")) {
        const blocks = (msg.content as any[]).filter(b => b.type !== "tool_result" || toolUseIds.has(b.tool_use_id));
        if (blocks.length === msg.content.length) return msg;
        if (blocks.length === 0) return null;
        return { ...msg, content: blocks };
      }
      return msg;
    }).filter(Boolean) as Anthropic.MessageParam[];
    if (next.length === prev.length) break;
    prev = next;
  }
  return prev;
}

// ── Tier 1: Observation Masking ───────────────────────────────────────────────
// Keep last N tool_results intact, replace older ones with placeholder.
// Preserves assistant reasoning (text blocks) — only masks raw tool output.

function applyObservationMasking(messages: Anthropic.MessageParam[], keepLast: number): Anthropic.MessageParam[] {
  // Count tool_results from the end
  let toolResultCount = 0;
  const indices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content) && (msg.content as any[]).some(b => b.type === "tool_result")) {
      toolResultCount++;
      if (toolResultCount > keepLast) indices.push(i);
    }
  }

  if (indices.length === 0) return messages;
  const indexSet = new Set(indices);

  return messages.map((msg, i) => {
    if (!indexSet.has(i)) return msg;
    // Mask tool_result content but keep the structure (tool_use_id must remain for API validity)
    const content = (msg.content as any[]).map((b: any) => {
      if (b.type === "tool_result") {
        return { ...b, content: "[Previous tool output cleared — reasoning preserved in assistant messages above]" };
      }
      return b;
    });
    return { ...msg, content };
  });
}

// ── Tier 2: LLM Summarization ─────────────────────────────────────────────────

async function summarizePrefix(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  const transcript = messages.map((m) => {
    const role = m.role === "user" ? "User" : "Assistant";
    if (typeof m.content === "string") return `${role}: ${m.content}`;
    if (!Array.isArray(m.content)) return "";
    const parts = (m.content as any[]).flatMap((b: any) => {
      if (b.type === "text") return [b.text.slice(0, 500)];
      if (b.type === "tool_use") return [`[Called ${b.name}]`];
      if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        return [`[Result: ${content.slice(0, 200)}]`];
      }
      return [];
    });
    return `${role}: ${parts.join(" ")}`;
  }).filter(Boolean).join("\n");

  try {
    const provider = createSummaryProvider();
    const { content } = await provider.stream({
      systemPrompt: `你是对话历史压缩专家。将对话历史压缩为结构化摘要，供 AI 助手在后续对话中使用。

必须保留：
- 用户的核心目标和当前任务状态
- 关键决策及其原因
- 重要发现、错误信息、异常情况
- 已创建/修改的文件路径和关键内容摘要
- 未解决的问题和待办事项
- 重要配置、环境信息

可以丢弃：
- 成功执行命令的详细输出
- 重复信息
- 已解决问题的详细排查过程
- 中间步骤的冗余细节

输出格式（Markdown）：
## 任务背景
## 已完成工作
## 当前状态与待办
## 重要参考信息`,
      messages: [{ role: "user", content: `压缩以下对话历史：\n\n${transcript.slice(0, 40000)}` }],
      tools: [],
      onText: () => {},
    });

    const summary = content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    return [
      { role: "user", content: `[早期对话摘要]\n${summary}` },
      { role: "assistant", content: "好的，我已了解之前的上下文。" },
    ];
  } catch (error) {
    logger.warn("summarize_prefix_failed", { messageCount: messages.length, error: error instanceof Error ? error.message : String(error) });
    // Fallback: keep assistant reasoning, mask all old tool outputs
    return applyObservationMasking(messages, 0).map((m) => {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const content = (m.content as any[]).filter((b: any) => b.type !== "thinking");
        return content.length > 0 ? { ...m, content } : null;
      }
      return m;
    }).filter(Boolean) as Anthropic.MessageParam[];
  }
}

function createSummaryProvider() {
  const cfg = agentConfig.current;
  return createProvider({
    type: cfg.type,
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    model: SUMMARY_MODEL ?? (cfg.type === "anthropic" ? "claude-haiku-4-5-20251001" : cfg.model),
    maxTokens: 2000,
  });
}

// ── Cache control helpers ─────────────────────────────────────────────────────

export function applyCache<T extends Anthropic.Tool>(tools: T[]): any[] {
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
  );
}
