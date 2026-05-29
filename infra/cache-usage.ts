import type { Trace } from "./trace.js";

export type CacheUsageSummary = {
  traceCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRatio: number;
  byTrace: Array<{
    id: string;
    startTs: number;
    userMessage: string;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cacheHitRatio: number;
  }>;
};

export function summarizeCacheUsage(traces: Trace[]): CacheUsageSummary {
  const byTrace = traces.map(trace => {
    const usages = trace.events
      .filter((event): event is Extract<Trace["events"][number], { type: "llm_response" }> => event.type === "llm_response")
      .map(event => event.usage)
      .filter(Boolean) as any[];
    const inputTokens = sum(usages, "input_tokens");
    const outputTokens = sum(usages, "output_tokens");
    const cacheReadTokens = sum(usages, "cache_read_input_tokens");
    const cacheCreationTokens = sum(usages, "cache_creation_input_tokens");
    return {
      id: trace.id,
      startTs: trace.startTs,
      userMessage: trace.userMessage,
      requestCount: usages.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheHitRatio: ratio(cacheReadTokens, inputTokens + cacheReadTokens),
    };
  }).filter(row => row.requestCount > 0);

  const inputTokens = byTrace.reduce((acc, row) => acc + row.inputTokens, 0);
  const outputTokens = byTrace.reduce((acc, row) => acc + row.outputTokens, 0);
  const cacheReadTokens = byTrace.reduce((acc, row) => acc + row.cacheReadTokens, 0);
  const cacheCreationTokens = byTrace.reduce((acc, row) => acc + row.cacheCreationTokens, 0);

  return {
    traceCount: byTrace.length,
    requestCount: byTrace.reduce((acc, row) => acc + row.requestCount, 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRatio: ratio(cacheReadTokens, inputTokens + cacheReadTokens),
    byTrace,
  };
}

function sum(rows: any[], key: string): number {
  return rows.reduce((acc, row) => acc + (Number(row?.[key]) || 0), 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}
