import { createLogger } from "./logger.js";

const logger = createLogger("task");

export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export type SubAgentRun = {
  id: string;
  taskId: string;
  agentName: string;
  prompt: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  startedAt: number;
  completedAt?: number;
};

export type Task = {
  id: string;
  sessionId: string;
  name: string;
  status: TaskStatus;
  createdAt: number;
  completedAt?: number;
  result?: string;
  subAgents: SubAgentRun[];
  cwd?: string;
  isolation?: "none" | "worktree";
};

// ── In-memory store (will add SQLite persistence later) ───────────────────────

const tasks = new Map<string, Task>();

export function createTask(sessionId: string, name: string, opts?: { cwd?: string; isolation?: "none" | "worktree" }): Task {
  const task: Task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    name,
    status: "pending",
    createdAt: Date.now(),
    subAgents: [],
    cwd: opts?.cwd,
    isolation: opts?.isolation ?? "none",
  };
  tasks.set(task.id, task);
  logger.info("task_created", { id: task.id, sessionId, name, isolation: task.isolation });
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function getSessionTasks(sessionId: string): Task[] {
  return [...tasks.values()].filter(t => t.sessionId === sessionId);
}

export function getCompletedTasks(sessionId: string): Task[] {
  return getSessionTasks(sessionId).filter(t => t.status === "done" || t.status === "failed");
}

export function getPendingTasks(sessionId: string): Task[] {
  return getSessionTasks(sessionId).filter(t => t.status === "pending" || t.status === "running");
}

export function addSubAgent(taskId: string, agentName: string, prompt: string): SubAgentRun | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  const run: SubAgentRun = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    taskId,
    agentName,
    prompt,
    status: "pending",
    startedAt: Date.now(),
  };
  task.subAgents.push(run);
  if (task.status === "pending") task.status = "running";
  logger.info("sub_agent_added", { taskId, runId: run.id, agentName });
  return run;
}

export function startSubAgent(taskId: string, runId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;
  const run = task.subAgents.find(r => r.id === runId);
  if (run) run.status = "running";
}

export function completeSubAgent(taskId: string, runId: string, result: string): void {
  const task = tasks.get(taskId);
  if (!task) return;
  const run = task.subAgents.find(r => r.id === runId);
  if (!run) return;
  run.status = "done";
  run.result = result;
  run.completedAt = Date.now();
  checkTaskCompletion(task);
}

export function failSubAgent(taskId: string, runId: string, error: string): void {
  const task = tasks.get(taskId);
  if (!task) return;
  const run = task.subAgents.find(r => r.id === runId);
  if (!run) return;
  run.status = "failed";
  run.result = error;
  run.completedAt = Date.now();
  checkTaskCompletion(task);
}

function checkTaskCompletion(task: Task): void {
  if (!task.subAgents.every(r => r.status === "done" || r.status === "failed")) return;
  task.status = task.subAgents.some(r => r.status === "failed") ? "failed" : "done";
  task.completedAt = Date.now();
  task.result = task.subAgents.map(r => `[${r.agentName}] ${r.result ?? "no result"}`).join("\n");
  logger.info("task_completed", { id: task.id, status: task.status, subAgentCount: task.subAgents.length });
}

export function cancelTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task || task.status === "done" || task.status === "cancelled") return false;
  task.status = "cancelled";
  task.completedAt = Date.now();
  for (const run of task.subAgents) {
    if (run.status === "pending" || run.status === "running") run.status = "failed";
  }
  logger.info("task_cancelled", { id: task.id });
  return true;
}

export function deleteTask(taskId: string): boolean {
  return tasks.delete(taskId);
}

export function clearSessionTasks(sessionId: string): void {
  for (const [id, task] of tasks) {
    if (task.sessionId === sessionId) tasks.delete(id);
  }
}
