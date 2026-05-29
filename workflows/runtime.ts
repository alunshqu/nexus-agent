import { randomUUID } from "crypto";
import type { AgentTeamWorkflow } from "./agent-team.js";
import { advanceWorkflowRun, getRunnablePhases, type WorkflowRun, type WorkflowRunPhase } from "./runner.js";
import { createWorkflowStore, type WorkflowStore } from "./store.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("workflow-runtime");

export type WorkflowArtifactInput = {
  name: string;
  contentType: string;
  content: string;
};

export type WorkflowExecutorResult = {
  output: string;
  artifacts?: WorkflowArtifactInput[];
};

export type WorkflowExecutorContext = {
  run: WorkflowRun;
  phase: WorkflowRunPhase;
  attempt: number;
  previousOutputs: Record<string, string>;
};

export type WorkflowExecutor = (context: WorkflowExecutorContext) => Promise<WorkflowExecutorResult>;

export type RunWorkflowOptions = {
  workflow?: AgentTeamWorkflow;
  runId?: string;
  store?: WorkflowStore;
  executor: WorkflowExecutor;
  workerId?: string;
  defaultTimeoutMs?: number;
  defaultMaxAttempts?: number;
  lockTtlMs?: number;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.WORKFLOW_PHASE_TIMEOUT_MS ?? 10 * 60 * 1000);
const DEFAULT_MAX_ATTEMPTS = Number(process.env.WORKFLOW_PHASE_MAX_ATTEMPTS ?? 1);
const DEFAULT_LOCK_TTL_MS = Number(process.env.WORKFLOW_LOCK_TTL_MS ?? 60 * 60 * 1000);

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRun> {
  const store = options.store ?? createWorkflowStore();
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  let run = resolveRun(store, options);

  if (!store.acquireRunLock(run.id, workerId, options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS)) {
    throw new Error(`Workflow run is locked: ${run.id}`);
  }

  try {
    store.appendEvent(run.id, "run_started", { workerId, status: run.status });
    while (true) {
      const [phase] = getRunnablePhases(run);
      if (!phase) break;

      run = await runPhase({
        store,
        run,
        phase,
        executor: options.executor,
        defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      });

      if (run.status === "failed" || run.status === "completed") break;
    }

    store.appendEvent(run.id, run.status === "completed" ? "run_completed" : "run_stopped", { status: run.status });
    return run;
  } finally {
    store.releaseRunLock(run.id, workerId);
  }
}

export async function resumeRunnableWorkflows(options: Omit<RunWorkflowOptions, "workflow" | "runId"> & { limit?: number }): Promise<WorkflowRun[]> {
  const store = options.store ?? createWorkflowStore();
  const runs = store.listRunnableRuns(options.limit ?? 20);
  const completed: WorkflowRun[] = [];
  for (const run of runs) {
    completed.push(await runWorkflow({ ...options, store, runId: run.id }));
  }
  return completed;
}

async function runPhase(args: {
  store: WorkflowStore;
  run: WorkflowRun;
  phase: WorkflowRunPhase;
  executor: WorkflowExecutor;
  defaultTimeoutMs: number;
  defaultMaxAttempts: number;
}): Promise<WorkflowRun> {
  const { store, executor, defaultTimeoutMs, defaultMaxAttempts } = args;
  const phaseConfig = args.run.workflow.phases.find(p => p.name === args.phase.name);
  const timeoutMs = phaseConfig?.timeoutMs ?? defaultTimeoutMs;
  const maxAttempts = Math.max(1, phaseConfig?.maxAttempts ?? defaultMaxAttempts);
  let run = advanceWorkflowRun(args.run, args.phase.name, { status: "running" });
  store.saveRun(run);
  store.appendEvent(run.id, "phase_started", { phase: args.phase.name, owner: args.phase.owner, timeoutMs, maxAttempts });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const latestPhase = run.phases.find(p => p.name === args.phase.name)!;
      const result = await withTimeout(
        executor({ run, phase: latestPhase, attempt, previousOutputs: collectPreviousOutputs(run, args.phase.name) }),
        timeoutMs,
        `Workflow phase timeout after ${timeoutMs}ms: ${args.phase.name}`
      );

      for (const artifact of result.artifacts ?? []) {
        validateArtifact(artifact);
        store.saveArtifact(run.id, args.phase.name, artifact.name, artifact.contentType, artifact.content);
      }

      run = advanceWorkflowRun(run, args.phase.name, { status: "completed", output: result.output });
      store.saveRun(run);
      store.appendEvent(run.id, "phase_completed", { phase: args.phase.name, attempt, outputLength: result.output.length });
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("phase_attempt_failed", error, { runId: run.id, phase: args.phase.name, attempt });
      store.appendEvent(run.id, attempt < maxAttempts ? "phase_retry" : "phase_failed", { phase: args.phase.name, attempt, error: message });
      if (attempt >= maxAttempts) {
        run = advanceWorkflowRun(run, args.phase.name, { status: "failed", error: message });
        store.saveRun(run);
        return run;
      }
    }
  }

  return run;
}

function resolveRun(store: WorkflowStore, options: RunWorkflowOptions): WorkflowRun {
  if (options.runId) {
    const run = store.getRun(options.runId);
    if (!run) throw new Error(`Workflow run not found: ${options.runId}`);
    return run;
  }
  if (!options.workflow) throw new Error("Either workflow or runId is required");
  return store.createRun(options.workflow);
}

function collectPreviousOutputs(run: WorkflowRun, phaseName: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const phase of run.phases) {
    if (phase.name === phaseName) break;
    if (phase.output !== undefined) outputs[phase.name] = phase.output;
  }
  return outputs;
}

function validateArtifact(artifact: WorkflowArtifactInput): void {
  if (!artifact.name || artifact.name.length > 255) throw new Error("Invalid artifact name");
  if (!artifact.contentType || artifact.contentType.length > 100) throw new Error("Invalid artifact contentType");
  if (typeof artifact.content !== "string") throw new Error("Invalid artifact content");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
