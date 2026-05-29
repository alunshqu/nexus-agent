import { describe, it, expect } from "vitest";
import { compactNineSectionSummary } from "../domain/cold-start.js";
import type Anthropic from "@anthropic-ai/sdk";

describe("cold start summary", () => {
  it("includes message content without repeating it across sections", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "目标是优化缓存" },
      { role: "assistant", content: "已完成 skill 放 system prompt" },
    ];
    const summary = compactNineSectionSummary(messages);
    expect(summary).toContain("冷启动");
    expect(summary).toContain("目标是优化缓存");
    expect(summary).toContain("已完成 skill 放 system prompt");
    // evidence should appear exactly once, not repeated across multiple sections
    const count = (summary.match(/目标是优化缓存/g) ?? []).length;
    expect(count).toBe(1);
  });
});
