import { describe, it, expect } from "vitest";
import { summarizeTrace } from "../observability/trace-summary.js";

describe("trace summary", () => {
  it("summarizes duration, llm calls, tools, slowest tool and usage", () => {
    const summary = summarizeTrace({
      id: "t1",
      sessionId: "s1",
      userMessage: "hi",
      model: "m",
      startTs: 1000,
      endTs: 2500,
      events: [
        { type: "llm_call", iteration: 0, model: "m", systemPrompt: "", messages: [], ts: 1000 },
        { type: "tool_call", name: "web_fetch", input: {}, ts: 1100 },
        { type: "tool_result", name: "web_fetch", result: "ok", is_error: false, durationMs: 800, ts: 1900 },
        { type: "done", totalMs: 1500, totalUsage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }, ts: 2500 },
      ],
    });
    expect(summary.totalMs).toBe(1500);
    expect(summary.llmCalls).toBe(1);
    expect(summary.toolCalls).toBe(1);
    expect(summary.slowestTool?.name).toBe("web_fetch");
    expect(summary.totalTokens).toBe(120);
    expect(summary.cacheReadTokens).toBe(50);
  });
});
