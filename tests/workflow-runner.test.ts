import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { buildAgentTeamWorkflow } from "../workflows/agent-team.js";
import { buildWorkflowRun, getRunnablePhases, advanceWorkflowRun } from "../workflows/runner.js";
import { createWorkflowStore } from "../workflows/store.js";
import { runWorkflow } from "../workflows/runtime.js";

describe("production workflow runtime", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "agent-workflow-test-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("persists runs, events and artifacts in sqlite", () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const run = store.createRun(buildAgentTeamWorkflow("research", "调研 agent 趋势"));

    store.appendEvent(run.id, "run_started", { objective: run.workflow.objective });
    store.saveArtifact(run.id, "collect", "sources", "text/plain", "source list");

    const loaded = store.getRun(run.id);
    expect(loaded?.id).toBe(run.id);
    expect(store.listRuns()[0].id).toBe(run.id);
    expect(store.listEvents(run.id).map(e => e.type)).toEqual(["run_started"]);
    expect(store.listArtifacts(run.id)[0]).toMatchObject({ phaseName: "collect", name: "sources", content: "source list" });
  });

  it("runs phases sequentially with retry, timeout protection and artifacts", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const workflow = buildAgentTeamWorkflow("research", "调研 agent 趋势");
    workflow.phases = workflow.phases.map(p => ({ ...p, timeoutMs: 100, maxAttempts: 2 }));
    const attempts: Record<string, number> = {};

    const result = await runWorkflow({
      store,
      workflow,
      executor: async ({ phase }) => {
        attempts[phase.name] = (attempts[phase.name] ?? 0) + 1;
        if (phase.name === "verify" && attempts[phase.name] === 1) throw new Error("transient verify error");
        return { output: `${phase.name}-done`, artifacts: [{ name: `${phase.name}.txt`, contentType: "text/plain", content: "ok" }] };
      },
    });

    expect(result.status).toBe("completed");
    expect(attempts.verify).toBe(2);
    expect(store.listArtifacts(result.id)).toHaveLength(3);
    expect(store.listEvents(result.id).some(e => e.type === "phase_retry")).toBe(true);
  });

  it("marks a phase failed after timeout and does not continue", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const workflow = buildAgentTeamWorkflow("code", "修 bug");
    workflow.phases = workflow.phases.map(p => ({ ...p, timeoutMs: 10, maxAttempts: 1 }));

    const result = await runWorkflow({
      store,
      workflow,
      executor: async ({ phase }) => {
        if (phase.name === "plan") await new Promise(resolve => setTimeout(resolve, 50));
        return { output: "done" };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.phases.find(p => p.name === "plan")?.status).toBe("failed");
    expect(result.phases.find(p => p.name === "implement")?.status).toBe("pending");
  });

  it("prevents duplicate execution of an already running run", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const run = store.createRun(buildAgentTeamWorkflow("kb", "整理知识库"));
    store.acquireRunLock(run.id, "worker-a", 1_000);

    await expect(runWorkflow({
      store,
      runId: run.id,
      executor: async () => ({ output: "never" }),
    })).rejects.toThrow(/locked/);
  });
});

// Keep legacy runner behavior covered while runtime grows.
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
