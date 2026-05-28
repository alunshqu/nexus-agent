import type { TraceSummary } from "./trace-summary.js";

export type TraceDashboard = {
  traceCount: number;
  totalMs: number;
  avgMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  errorRate: number;
  slowestTools: Array<{ traceId: string; name: string; durationMs: number }>;
};

export function buildTraceDashboard(summaries: TraceSummary[]): TraceDashboard {
  const traceCount = summaries.length;
  const totalMs = summaries.reduce((sum, s) => sum + s.totalMs, 0);
  const errorCount = summaries.filter(s => s.errors > 0).length;
  const slowestTools = summaries
    .filter(s => s.slowestTool)
    .map(s => ({ traceId: s.traceId, name: s.slowestTool!.name, durationMs: s.slowestTool!.durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);

  return {
    traceCount,
    totalMs,
    avgMs: traceCount ? Math.round(totalMs / traceCount) : 0,
    totalTokens: summaries.reduce((sum, s) => sum + s.totalTokens, 0),
    inputTokens: summaries.reduce((sum, s) => sum + s.inputTokens, 0),
    outputTokens: summaries.reduce((sum, s) => sum + s.outputTokens, 0),
    cacheReadTokens: summaries.reduce((sum, s) => sum + s.cacheReadTokens, 0),
    cacheCreateTokens: summaries.reduce((sum, s) => sum + s.cacheCreateTokens, 0),
    errorRate: traceCount ? errorCount / traceCount : 0,
    slowestTools,
  };
}
