import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTask, getTask, getSessionTasks, addSubAgent, completeSubAgent, failSubAgent, cancelTask, clearSessionTasks, getPendingTasks, getCompletedTasks } from "../infra/task.js";

// ── Task runner tests ─────────────────────────────────────────────────────────
// Tests the async execution flow: create task → run sub-agents in background → complete

describe("async task runner", () => {
  beforeEach(() => { clearSessionTasks("s1"); });

  it("task_create returns immediately with task_id", () => {
    const task = createTask("s1", "search news");
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    // Main agent gets task_id back immediately, doesn't wait
  });

  it("sub-agents can be added and started independently", () => {
    const task = createTask("s1", "research");
    const run1 = addSubAgent(task.id, "web_researcher", "find news")!;
    const run2 = addSubAgent(task.id, "web_researcher", "find competitors")!;
    expect(task.subAgents).toHaveLength(2);
    expect(run1.status).toBe("pending");
    expect(run2.status).toBe("pending");
    expect(task.status).toBe("running");
  });

  it("getPendingTasks returns running tasks", () => {
    const t1 = createTask("s1", "task1");
    addSubAgent(t1.id, "a", "work");
    const t2 = createTask("s1", "task2"); // pending, no sub-agents
    expect(getPendingTasks("s1")).toHaveLength(2);
  });

  it("getCompletedTasks returns done/failed tasks", () => {
    const t1 = createTask("s1", "task1");
    const run = addSubAgent(t1.id, "a", "work")!;
    completeSubAgent(t1.id, run.id, "done");
    const t2 = createTask("s1", "task2");
    addSubAgent(t2.id, "b", "work");
    expect(getCompletedTasks("s1")).toHaveLength(1);
    expect(getCompletedTasks("s1")[0].id).toBe(t1.id);
  });

  it("concurrent sub-agents complete independently", async () => {
    const task = createTask("s1", "parallel research");
    const run1 = addSubAgent(task.id, "agent_a", "task1")!;
    const run2 = addSubAgent(task.id, "agent_b", "task2")!;

    // Simulate async completion at different times
    await new Promise(r => setTimeout(r, 10));
    completeSubAgent(task.id, run1.id, "result from A");
    expect(task.status).toBe("running"); // still waiting for run2

    await new Promise(r => setTimeout(r, 10));
    completeSubAgent(task.id, run2.id, "result from B");
    expect(task.status).toBe("done");
    expect(task.result).toContain("result from A");
    expect(task.result).toContain("result from B");
  });

  it("task result aggregates all sub-agent results", () => {
    const task = createTask("s1", "multi-search");
    const r1 = addSubAgent(task.id, "searcher", "query1")!;
    const r2 = addSubAgent(task.id, "analyzer", "query2")!;
    completeSubAgent(task.id, r1.id, "news about AI");
    completeSubAgent(task.id, r2.id, "competitor analysis");
    expect(task.result).toContain("[searcher] news about AI");
    expect(task.result).toContain("[analyzer] competitor analysis");
  });

  it("cancellation stops pending sub-agents", () => {
    const task = createTask("s1", "long task");
    const r1 = addSubAgent(task.id, "a", "work1")!;
    const r2 = addSubAgent(task.id, "b", "work2")!;
    completeSubAgent(task.id, r1.id, "done");
    cancelTask(task.id);
    expect(task.status).toBe("cancelled");
    expect(r1.status).toBe("done"); // already completed, not changed
    expect(r2.status).toBe("failed"); // was pending, now failed
  });
});

// ── Task tool schema tests ────────────────────────────────────────────────────

describe("task tool interface", () => {
  beforeEach(() => { clearSessionTasks("s1"); });

  it("task_create input: name + subAgents array", () => {
    // Simulates what the model would pass to task_create
    const input = {
      name: "查新闻",
      sub_agents: [
        { agent: "web_researcher", task: "搜索今天科技新闻" },
        { agent: "web_researcher", task: "搜索竞品动态" },
      ],
    };
    const task = createTask("s1", input.name);
    for (const sa of input.sub_agents) {
      addSubAgent(task.id, sa.agent, sa.task);
    }
    expect(task.subAgents).toHaveLength(2);
    expect(task.status).toBe("running");
  });

  it("task_status returns current state", () => {
    const task = createTask("s1", "test");
    const run = addSubAgent(task.id, "a", "work")!;
    // Simulate what task_status tool would return
    const status = {
      id: task.id,
      name: task.name,
      status: task.status,
      subAgents: task.subAgents.map(r => ({ id: r.id, agent: r.agentName, status: r.status })),
    };
    expect(status.status).toBe("running");
    expect(status.subAgents).toHaveLength(1);
  });

  it("task_list returns all session tasks with status", () => {
    createTask("s1", "task1");
    const t2 = createTask("s1", "task2");
    const run = addSubAgent(t2.id, "a", "work")!;
    completeSubAgent(t2.id, run.id, "done");

    const list = getSessionTasks("s1").map(t => ({ id: t.id, name: t.name, status: t.status }));
    expect(list).toHaveLength(2);
    expect(list[1].status).toBe("done");
  });
});
