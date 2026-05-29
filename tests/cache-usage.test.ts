import { describe, it, expect } from "vitest";
import { summarizeCacheUsage } from "../infra/cache-usage.js";
import type { Trace } from "../infra/trace.js";

describe("cache usage summary", () => {
  it("summarizes cache read/create tokens across traces", () => {
    const traces: Trace[] = [
      {
        id: "t1",
        sessionId: "s",
        userMessage: "hello",
        model: "m",
        startTs: 1,
        events: [
          { type: "llm_response", iteration: 0, stopReason: "end_turn", content: [], usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, ts: 1 },
        ],
      },
      {
        id: "t2",
        sessionId: "s",
        userMessage: "next",
        model: "m",
        startTs: 2,
        events: [
          { type: "llm_response", iteration: 0, stopReason: "end_turn", content: [], usage: { input_tokens: 300, output_tokens: 7, cache_read_input_tokens: 100 }, ts: 2 },
          { type: "llm_response", iteration: 1, stopReason: "end_turn", content: [], usage: { input_tokens: 200, output_tokens: 3 }, ts: 3 },
        ],
      },
    ];

    const summary = summarizeCacheUsage(traces);
    expect(summary.traceCount).toBe(2);
    expect(summary.requestCount).toBe(3);
    expect(summary.inputTokens).toBe(600);
    expect(summary.outputTokens).toBe(15);
    expect(summary.cacheReadTokens).toBe(150);
    expect(summary.cacheCreationTokens).toBe(10);
    expect(summary.cacheHitRatio).toBe(0.2);
    expect(summary.byTrace[0].cacheHitRatio).toBe(0.3333);
  });
});
