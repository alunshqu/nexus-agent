import { describe, it, expect } from "vitest";
import { compactNineSectionSummary } from "../domain/cold-start.js";
import type Anthropic from "@anthropic-ai/sdk";

describe("nine-section cold start summary", () => {
  it("produces a structured nine-section summary", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "目标是优化缓存" },
      { role: "assistant", content: "已完成 skill 放 system prompt" },
    ];
    const summary = compactNineSectionSummary(messages);
    for (const title of ["会话目标", "已完成任务", "未完成任务", "关键决策和理由", "代码变更摘要", "发现的问题", "待验证的假设", "用户偏好", "上下文关键信息"]) {
      expect(summary).toContain(`## ${title}`);
    }
  });
});
