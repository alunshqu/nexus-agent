import type { Trace } from "../infra/trace.js";

export type TraceSummary = {
  traceId: string;
  totalMs: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  slowestTool?: { name: string; durationMs: number };
};

export function summarizeTrace(trace: Trace): TraceSummary {
  const toolResults = trace.events.filter((e): e is Extract<Trace["events"][number], { type: "tool_result" }> => e.type === "tool_result");
  const done = trace.events.find((e): e is Extract<Trace["events"][number], { type: "done" }> => e.type === "done");
  const usage = done?.totalUsage ?? {};
  const slowest = [...toolResults].sort((a, b) => b.durationMs - a.durationMs)[0];

  return {
    traceId: trace.id,
    totalMs: done?.totalMs ?? (trace.endTs && trace.startTs ? trace.endTs - trace.startTs : 0),
    llmCalls: trace.events.filter(e => e.type === "llm_call").length,
    toolCalls: trace.events.filter(e => e.type === "tool_call").length,
    errors: trace.events.filter(e => e.type === "error" || (e.type === "tool_result" && e.is_error)).length,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    slowestTool: slowest ? { name: slowest.name, durationMs: slowest.durationMs } : undefined,
  };
}
