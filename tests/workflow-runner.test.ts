import { describe, it, expect } from "vitest";
import { buildWorkflowRun, advanceWorkflowRun, getRunnablePhases } from "../workflows/runner.js";
import { buildAgentTeamWorkflow } from "../workflows/agent-team.js";

describe("workflow runner", () => {
  it("creates a run with pending phases", () => {
    const run = buildWorkflowRun(buildAgentTeamWorkflow("research", "调研 agent 趋势"));
    expect(run.status).toBe("pending");
    expect(run.phases[0].status).toBe("pending");
  });

  it("advances phases and completes the run", () => {
    let run = buildWorkflowRun(buildAgentTeamWorkflow("research", "调研 agent 趋势"));
    expect(getRunnablePhases(run).map(p => p.name)).toEqual(["collect"]);
    run = advanceWorkflowRun(run, "collect", { status: "completed", output: "sources" });
    expect(getRunnablePhases(run).map(p => p.name)).toEqual(["verify"]);
    run = advanceWorkflowRun(run, "verify", { status: "completed", output: "checked" });
    run = advanceWorkflowRun(run, "report", { status: "completed", output: "report" });
    expect(run.status).toBe("completed");
  });

  it("marks run failed when a phase fails", () => {
    let run = buildWorkflowRun(buildAgentTeamWorkflow("code", "修 bug"));
    run = advanceWorkflowRun(run, "plan", { status: "failed", error: "bad requirement" });
    expect(run.status).toBe("failed");
  });
});
