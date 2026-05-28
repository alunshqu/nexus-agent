import { describe, it, expect } from "vitest";
import { truncateToolOutput, estimateTokens } from "../domain/context.js";
import type Anthropic from "@anthropic-ai/sdk";

// ── truncateToolOutput ────────────────────────────────────────────────────────

describe("truncateToolOutput", () => {
  it("returns output unchanged when under limit", () => {
    const out = "a".repeat(100);
    expect(truncateToolOutput(out)).toBe(out);
  });

  it("truncates long output with head+tail+omission marker", () => {
    const out = "a".repeat(30000);
    const result = truncateToolOutput(out);
    expect(result.length).toBeLessThan(out.length);
    expect(result).toContain("chars omitted");
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("a")).toBe(true);
  });

  it("empty string passes through", () => {
    expect(truncateToolOutput("")).toBe("");
  });

  it("output exactly at limit passes through", () => {
    const limit = Number(process.env.SOURCE_TRUNCATE_LIMIT ?? 20000);
    const out = "x".repeat(limit);
    expect(truncateToolOutput(out)).toBe(out);
  });

  it("output one over limit gets truncated", () => {
    const limit = Number(process.env.SOURCE_TRUNCATE_LIMIT ?? 20000);
    const out = "x".repeat(limit + 1);
    expect(truncateToolOutput(out)).not.toBe(out);
    expect(truncateToolOutput(out)).toContain("chars omitted");
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("string content: ceil(length/3)", () => {
    const msg: Anthropic.MessageParam = { role: "user", content: "abc" }; // 3 chars → 1 token
    expect(estimateTokens(msg)).toBe(1);
    const msg2: Anthropic.MessageParam = { role: "user", content: "abcd" }; // 4 chars → 2 tokens
    expect(estimateTokens(msg2)).toBe(2);
  });

  it("text block: ceil(text.length/3)", () => {
    const msg: Anthropic.MessageParam = {
      role: "assistant",
      content: [{ type: "text", text: "hello world" }], // 11 chars → 4 tokens
    };
    expect(estimateTokens(msg)).toBe(4);
  });

  it("tool_use block: ceil(JSON(input).length/3) + 20", () => {
    const input = { query: "test" }; // JSON = '{"query":"test"}' = 16 chars → ceil(16/3)+20 = 6+20 = 26
    const msg: Anthropic.MessageParam = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "web_search", input }],
    };
    const expected = Math.ceil(JSON.stringify(input).length / 3) + 20;
    expect(estimateTokens(msg)).toBe(expected);
  });

  it("tool_result block: ceil(content.length/3)", () => {
    const content = "search results here"; // 19 chars → 7 tokens
    const msg: Anthropic.MessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content }],
    };
    expect(estimateTokens(msg)).toBe(Math.ceil(content.length / 3));
  });

  it("tool_result with object content: uses JSON.stringify", () => {
    const content = [{ type: "text" as const, text: "result" }];
    const msg: Anthropic.MessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content } as any],
    };
    expect(estimateTokens(msg)).toBe(Math.ceil(JSON.stringify(content).length / 3));
  });

  it("thinking block: ceil(thinking.length/3)", () => {
    const thinking = "I need to think about this carefully";
    const msg: Anthropic.MessageParam = {
      role: "assistant",
      content: [{ type: "thinking", thinking, signature: "" } as any],
    };
    expect(estimateTokens(msg)).toBe(Math.ceil(thinking.length / 3));
  });

  it("unknown block type: returns 10", () => {
    const msg: Anthropic.MessageParam = {
      role: "assistant",
      content: [{ type: "unknown_future_type" } as any],
    };
    expect(estimateTokens(msg)).toBe(10);
  });

  it("empty content array: returns 0", () => {
    const msg: Anthropic.MessageParam = { role: "user", content: [] };
    expect(estimateTokens(msg)).toBe(0);
  });

  it("multiple blocks: sums all", () => {
    const msg: Anthropic.MessageParam = {
      role: "assistant",
      content: [
        { type: "text", text: "abc" },   // ceil(3/3) = 1
        { type: "text", text: "defghi" }, // ceil(6/3) = 2
      ],
    };
    expect(estimateTokens(msg)).toBe(3);
  });
});
