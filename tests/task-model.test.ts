import { describe, it, expect, beforeEach } from "vitest";
import { createTask, getTask, getSessionTasks, addSubAgent, completeSubAgent, failSubAgent, cancelTask, clearSessionTasks } from "../infra/task.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("task CRUD", () => {
  beforeEach(() => { clearSessionTasks("s1"); clearSessionTasks("s2"); clearSessionTasks("s3"); clearSessionTasks("session-1"); });

  it("creates a task with pending status", () => {
    const task = createTask("session-1", "查新闻");
    expect(task.status).toBe("pending");
    expect(task.sessionId).toBe("session-1");
    expect(task.name).toBe("查新闻");
    expect(task.subAgents).toHaveLength(0);
  });

  it("retrieves task by id", () => {
    const task = createTask("s1", "test");
    expect(getTask(task.id)).toBe(task);
    expect(getTask("nonexistent")).toBeUndefined();
  });

  it("lists tasks by session", () => {
    createTask("s1", "task1");
    createTask("s1", "task2");
    createTask("s2", "task3");
    expect(getSessionTasks("s1")).toHaveLength(2);
    expect(getSessionTasks("s2")).toHaveLength(1);
    expect(getSessionTasks("s3")).toHaveLength(0);
  });
});

describe("sub-agent lifecycle", () => {
  beforeEach(() => { clearSessionTasks("s1"); });

  it("adding sub-agent transitions task to running", () => {
    const task = createTask("s1", "research");
    expect(task.status).toBe("pending");
    addSubAgent(task.id, "web_researcher", "find news");
    expect(task.status).toBe("running");
    expect(task.subAgents).toHaveLength(1);
  });

  it("completing all sub-agents transitions task to done", () => {
    const task = createTask("s1", "research");
    const run1 = addSubAgent(task.id, "agent_a", "task1")!;
    const run2 = addSubAgent(task.id, "agent_b", "task2")!;
    completeSubAgent(task.id, run1.id, "result1");
    expect(task.status).toBe("running");
    completeSubAgent(task.id, run2.id, "result2");
    expect(task.status).toBe("done");
    expect(task.result).toContain("result1");
    expect(task.result).toContain("result2");
  });

  it("any sub-agent failure marks task as failed", () => {
    const task = createTask("s1", "research");
    const run1 = addSubAgent(task.id, "agent_a", "task1")!;
    const run2 = addSubAgent(task.id, "agent_b", "task2")!;
    completeSubAgent(task.id, run1.id, "ok");
    failSubAgent(task.id, run2.id, "API error");
    expect(task.status).toBe("failed");
  });

  it("single sub-agent success marks task done", () => {
    const task = createTask("s1", "simple");
    const run = addSubAgent(task.id, "searcher", "find")!;
    completeSubAgent(task.id, run.id, "found it");
    expect(task.status).toBe("done");
    expect(task.result).toContain("found it");
  });
});

describe("task cancellation", () => {
  beforeEach(() => { clearSessionTasks("s1"); });

  it("cancels a running task", () => {
    const task = createTask("s1", "long task");
    addSubAgent(task.id, "agent", "work");
    expect(cancelTask(task.id)).toBe(true);
    expect(task.status).toBe("cancelled");
    expect(task.subAgents[0].status).toBe("failed");
  });

  it("cannot cancel a completed task", () => {
    const task = createTask("s1", "done task");
    const run = addSubAgent(task.id, "agent", "work")!;
    completeSubAgent(task.id, run.id, "done");
    expect(cancelTask(task.id)).toBe(false);
    expect(task.status).toBe("done");
  });

  it("cannot cancel already cancelled task", () => {
    const task = createTask("s1", "task");
    addSubAgent(task.id, "agent", "work");
    cancelTask(task.id);
    expect(cancelTask(task.id)).toBe(false);
  });
});

describe("task isolation", () => {
  beforeEach(() => { clearSessionTasks("s1"); });

  it("default isolation is none", () => {
    const task = createTask("s1", "task");
    expect(task.isolation).toBe("none");
  });

  it("can specify worktree isolation", () => {
    const task = createTask("s1", "code task", { isolation: "worktree", cwd: "/tmp/worktree-1" });
    expect(task.isolation).toBe("worktree");
    expect(task.cwd).toBe("/tmp/worktree-1");
  });
});

describe("task-session binding", () => {
  beforeEach(() => { clearSessionTasks("s1"); clearSessionTasks("session-a"); clearSessionTasks("session-b"); });

  it("tasks are bound to session", () => {
    const t1 = createTask("session-a", "task1");
    const t2 = createTask("session-b", "task2");
    expect(t1.sessionId).toBe("session-a");
    expect(t2.sessionId).toBe("session-b");
    expect(getSessionTasks("session-a")).toHaveLength(1);
  });

  it("multiple tasks in same session are independent", () => {
    const t1 = createTask("s1", "task1");
    const t2 = createTask("s1", "task2");
    const run1 = addSubAgent(t1.id, "a", "work1")!;
    addSubAgent(t2.id, "b", "work2");
    completeSubAgent(t1.id, run1.id, "done1");
    expect(t1.status).toBe("done");
    expect(t2.status).toBe("running");
  });
});
