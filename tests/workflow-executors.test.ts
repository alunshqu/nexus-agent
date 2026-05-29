import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { buildAgentTeamWorkflow } from "../workflows/agent-team.js";
import { buildWorkflowRun, advanceWorkflowRun } from "../workflows/runner.js";
import { createWorkflowStore } from "../workflows/store.js";
import { runWorkflow } from "../workflows/runtime.js";
import { createTaskWorkflowExecutor, finalizeWorkflowArtifacts, formatWorkflowProgress } from "../workflows/executors.js";
import { getWorkflowTemplate } from "../workflows/templates.js";

describe("task-oriented workflow executor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "agent-workflow-executor-test-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("runs built-in research workflow and writes progress summary artifact", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const result = await runWorkflow({
      store,
      workflow: buildAgentTeamWorkflow("research", "调研 agent workflow 趋势"),
      executor: createTaskWorkflowExecutor(store, {
        researchTools: {
          search: async () => JSON.stringify({
            provider: "fake",
            query: "调研 agent workflow 趋势",
            results: [
              { title: "Anthropic Building Effective Agents", url: "https://example.com/anthropic", snippet: "workflows are predefined; agents dynamically direct tool use" },
              { title: "LangGraph Overview", url: "https://example.com/langgraph", snippet: "agent workflows need state and durable execution" },
            ],
          }),
          fetch: async ({ url }) => JSON.stringify({ url, status: 200, body: `Official content for ${url}: workflows orchestrate steps; agents decide actions dynamically.` }),
        },
      }),
    });
    finalizeWorkflowArtifacts(store, result);

    expect(result.status).toBe("completed");
    expect(result.phases.map(p => p.status)).toEqual(["completed", "completed", "completed"]);
    expect(store.listArtifacts(result.id).map(a => a.name)).toContain("workflow-summary.md");
    expect(formatWorkflowProgress(result)).toContain("调研 agent workflow 趋势");
  });

  it("runs brainstorm template and emits final report", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const workflow = getWorkflowTemplate("brainstorm-council")!.build("构建下一个产品方向");
    const result = await runWorkflow({ store, workflow, executor: createTaskWorkflowExecutor(store) });
    finalizeWorkflowArtifacts(store, result);

    expect(result.status).toBe("completed");
    const final = store.listArtifacts(result.id).find(a => a.name === "final-report.md");
    expect(final?.content).toContain("LifeOS");
  });

  it("supports waiting approval status and resuming to pending", () => {
    const run = buildWorkflowRun(buildAgentTeamWorkflow("code", "修改高风险配置"));
    const paused = advanceWorkflowRun(run, "plan", { status: "waiting_approval", error: "需要确认" });
    expect(paused.status).toBe("waiting_approval");
    expect(paused.phases[0].status).toBe("waiting_approval");

    const resumed = advanceWorkflowRun(paused, "plan", { status: "pending", error: undefined });
    expect(resumed.status).toBe("pending");
    expect(resumed.phases[0].status).toBe("pending");
  });
});
