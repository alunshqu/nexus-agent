import { describe, it, expect } from "vitest";
import { buildTraceDashboard } from "../observability/dashboard.js";

describe("observability dashboard", () => {
  it("aggregates trace summaries", () => {
    const dashboard = buildTraceDashboard([
      {
        traceId: "t1", totalMs: 1000, llmCalls: 1, toolCalls: 2, errors: 0,
        inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheCreateTokens: 0, cacheReadTokens: 50,
        slowestTool: { name: "web_fetch", durationMs: 700 },
      },
      {
        traceId: "t2", totalMs: 3000, llmCalls: 2, toolCalls: 1, errors: 1,
        inputTokens: 200, outputTokens: 30, totalTokens: 230, cacheCreateTokens: 10, cacheReadTokens: 0,
        slowestTool: { name: "bash", durationMs: 1200 },
      },
    ]);
    expect(dashboard.traceCount).toBe(2);
    expect(dashboard.totalTokens).toBe(350);
    expect(dashboard.errorRate).toBe(0.5);
    expect(dashboard.slowestTools[0].name).toBe("bash");
  });
});
