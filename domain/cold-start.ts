import type Anthropic from "@anthropic-ai/sdk";

const DEFAULT_CACHE_TTL_MS = Number(process.env.PROMPT_CACHE_TTL_MS ?? 60 * 60 * 1000);
const DEFAULT_RECENT_MESSAGES = Number(process.env.COLD_START_RECENT_MESSAGES ?? 12);

export function shouldColdStartCompress(lastActivityAt: number | undefined, now = Date.now(), ttlMs = DEFAULT_CACHE_TTL_MS): boolean {
  if (!lastActivityAt) return false;
  return now - lastActivityAt > ttlMs;
}

export function coldStartCompressMessages(
  messages: Anthropic.MessageParam[],
  opts: { maxRecentMessages?: number } = {}
): { messages: Anthropic.MessageParam[]; compressed: boolean } {
  const maxRecentMessages = opts.maxRecentMessages ?? DEFAULT_RECENT_MESSAGES;
  if (messages.length <= maxRecentMessages + 2) return { messages, compressed: false };

  const recent = messages.slice(-maxRecentMessages);
  const prefix = messages.slice(0, -maxRecentMessages);
  const summary = compactNineSectionSummary(prefix);
  return {
    compressed: true,
    messages: [
      { role: "user", content: `[冷启动历史摘要]\n${summary}` },
      { role: "assistant", content: "好的，我已了解冷启动前的历史上下文。" },
      ...recent,
    ],
  };
}

export function compactNineSectionSummary(messages: Anthropic.MessageParam[]): string {
  const facts: string[] = [];
  for (const msg of messages) {
    const text = messageToText(msg).trim();
    if (!text) continue;
    const role = msg.role === "user" ? "用户" : "助手";
    facts.push(`- ${role}: ${text.slice(0, 500)}`);
  }
  const evidence = facts.slice(-40).join("\n") || "- 暂无";
  return [
    "缓存已过期，本次为冷启动。以下是压缩后的早期上下文，避免在无缓存情况下重复发送完整历史。",
    evidence,
  ].join("\n");
}

function messageToText(msg: Anthropic.MessageParam): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return (msg.content as any[]).map(block => {
    if (block.type === "text") return block.text ?? "";
    if (block.type === "tool_use") return `[调用工具 ${block.name}]`;
    if (block.type === "tool_result") return `[工具结果 ${String(block.content ?? "").slice(0, 200)}]`;
    return "";
  }).filter(Boolean).join(" ");
}
