import { describe, it, expect } from "vitest";
import { shouldColdStartCompress, coldStartCompressMessages } from "../domain/cold-start.js";
import type Anthropic from "@anthropic-ai/sdk";

describe("cold start context optimization", () => {
  it("detects cache expiry after one hour", () => {
    const now = 2 * 60 * 60 * 1000;
    expect(shouldColdStartCompress(now - 61 * 60 * 1000, now)).toBe(true);
    expect(shouldColdStartCompress(now - 30 * 60 * 1000, now)).toBe(false);
    expect(shouldColdStartCompress(undefined, now)).toBe(false);
  });

  it("keeps short conversations unchanged", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = coldStartCompressMessages(messages, { maxRecentMessages: 8 });
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("summarizes old prefix and keeps recent messages", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: `user ${i}` });
      messages.push({ role: "assistant", content: `assistant ${i}` });
    }
    const result = coldStartCompressMessages(messages, { maxRecentMessages: 4 });
    expect(result.compressed).toBe(true);
    expect(result.messages[0].role).toBe("user");
    expect(String(result.messages[0].content)).toContain("冷启动历史摘要");
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
  });
});
