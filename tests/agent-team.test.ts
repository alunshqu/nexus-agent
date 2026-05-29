import { describe, it, expect } from "vitest";
import { buildAgentTeamWorkflow, renderAgentTeamWorkflow } from "../workflows/agent-team.js";

describe("agent team workflows", () => {
  it("builds a research team", () => {
    const workflow = buildAgentTeamWorkflow("research", "调研市场");
    expect(workflow.roles.map(r => r.name)).toEqual(["researcher", "verifier", "writer"]);
    expect(workflow.phases).toHaveLength(3);
  });

  it("builds a coding team", () => {
    const workflow = buildAgentTeamWorkflow("code", "修复 bug");
    expect(workflow.roles.map(r => r.name)).toEqual(["planner", "implementer", "reviewer", "tester"]);
  });

  it("builds a brainstorm council", () => {
    const workflow = buildAgentTeamWorkflow("brainstorm", "构建划时代产品");
    expect(workflow.roles.map(r => r.name)).toContain("educator");
    expect(workflow.roles.map(r => r.name)).toContain("skeptic");
    expect(workflow.phases.map(p => p.name)).toEqual(["observe", "diverge", "challenge", "converge", "prototype", "roadmap"]);
  });

  it("renders workflow", () => {
    expect(renderAgentTeamWorkflow(buildAgentTeamWorkflow("kb", "IM 入库"))).toContain("Agent Team Workflow");
  });
});
