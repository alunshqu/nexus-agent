import type { AgentTeamWorkflow } from "./agent-team.js";

export type WorkflowPhaseStatus = "pending" | "running" | "completed" | "failed" | "waiting_approval";

export type WorkflowRunPhase = {
  name: string;
  owner: string;
  outputName: string;
  status: WorkflowPhaseStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

export type WorkflowRun = {
  id: string;
  workflow: AgentTeamWorkflow;
  status: WorkflowPhaseStatus;
  phases: WorkflowRunPhase[];
  createdAt: number;
  updatedAt: number;
};

export function buildWorkflowRun(workflow: AgentTeamWorkflow): WorkflowRun {
  const now = Date.now();
  return {
    id: `${workflow.kind}-${now}`,
    workflow,
    status: "pending",
    phases: workflow.phases.map(p => ({ name: p.name, owner: p.owner, outputName: p.output, status: "pending" })),
    createdAt: now,
    updatedAt: now,
  };
}

export function getRunnablePhases(run: WorkflowRun): WorkflowRunPhase[] {
  if (run.status === "failed" || run.status === "completed") return [];
  const next = run.phases.find(p => p.status === "pending" || p.status === "running");
  return next ? [next] : [];
}

export function advanceWorkflowRun(
  run: WorkflowRun,
  phaseName: string,
  update: { status: WorkflowPhaseStatus; output?: string; error?: string }
): WorkflowRun {
  const now = Date.now();
  const phases = run.phases.map(phase => phase.name === phaseName
    ? {
        ...phase,
        status: update.status,
        output: update.output ?? phase.output,
        error: update.error,
        startedAt: phase.startedAt ?? now,
        endedAt: update.status === "completed" || update.status === "failed" ? now : phase.endedAt,
      }
    : phase);

  const status: WorkflowPhaseStatus = phases.some(p => p.status === "failed")
    ? "failed"
    : phases.every(p => p.status === "completed")
    ? "completed"
    : phases.some(p => p.status === "waiting_approval")
    ? "waiting_approval"
    : phases.some(p => p.status === "running" || p.status === "completed")
    ? "running"
    : "pending";

  return { ...run, phases, status, updatedAt: now };
}
