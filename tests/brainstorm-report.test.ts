import { describe, it, expect } from "vitest";
import { buildAgentTeamWorkflow } from "../workflows/agent-team.js";
import { buildWorkflowRun, advanceWorkflowRun } from "../workflows/runner.js";
import { createBrainstormPhaseOutput, generateBrainstormReport } from "../workflows/brainstorm-report.js";

describe("brainstorm report", () => {
  it("generates deterministic phase outputs and final report", () => {
    const workflow = buildAgentTeamWorkflow("brainstorm", "构建划时代产品");
    let run = buildWorkflowRun(workflow);
    for (const phase of run.phases) {
      const output = createBrainstormPhaseOutput(workflow, phase.name, {});
      expect(output.length).toBeGreaterThan(20);
      run = advanceWorkflowRun(run, phase.name, { status: "completed", output });
    }

    const report = generateBrainstormReport(run);
    expect(report.title).toContain("构建划时代产品");
    expect(report.markdown).toContain("LifeOS");
    expect(report.markdown).toContain("30/60/90 天路线图");
  });

  it("rejects non-brainstorm workflows", () => {
    const run = buildWorkflowRun(buildAgentTeamWorkflow("research", "调研市场"));
    expect(() => generateBrainstormReport(run)).toThrow(/brainstorm/);
  });
});
