import { describe, it, expect } from "vitest";
import { buildPlan, renderPlanForReview } from "../workflows/planning.js";

describe("agent planning workflow", () => {
  it("builds a coding plan with review and validation steps", () => {
    const plan = buildPlan("修改代码并用 TDD 验证");
    expect(plan.mode).toBe("code_change");
    expect(plan.steps.map(s => s.kind)).toEqual(["inspect", "test_red", "implement", "test_green", "review", "commit"]);
  });

  it("builds a research plan", () => {
    const plan = buildPlan("调研 GitHub agent 趋势");
    expect(plan.mode).toBe("research");
    expect(plan.steps.map(s => s.kind)).toContain("verify_sources");
  });

  it("renders a human-readable review", () => {
    const text = renderPlanForReview(buildPlan("调研新闻"));
    expect(text).toContain("执行计划");
    expect(text).toContain("验收标准");
  });
});
