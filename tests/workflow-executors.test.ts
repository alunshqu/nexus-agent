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
          fetch: async ({ url }) => JSON.stringify({ url, status: 200, body: `Official content for ${url}: workflows orchestrate steps; agents decide actions dynamically. `.repeat(20) }),
        },
      }),
    });
    finalizeWorkflowArtifacts(store, result);

    expect(result.status).toBe("completed");
    expect(result.phases.map(p => p.status)).toEqual(["completed", "completed", "completed"]);
    expect(store.listArtifacts(result.id).map(a => a.name)).toContain("workflow-summary.md");
    expect(formatWorkflowProgress(result)).toContain("调研 agent workflow 趋势");
  });

  it("fails research workflow when quality gate has too few usable sources", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const result = await runWorkflow({
      store,
      workflow: buildAgentTeamWorkflow("research", "调研黄金 6 到 9 月趋势"),
      executor: createTaskWorkflowExecutor(store, {
        researchBudget: { minUsableSources: 2, maxFetches: 2 },
        researchTools: {
          search: async () => JSON.stringify({
            provider: "fake",
            results: [
              { title: "Blocked source", url: "https://example.com/blocked", snippet: "short" },
              { title: "Empty source", url: "https://example.com/empty", snippet: "short" },
            ],
          }),
          fetch: async ({ url }) => JSON.stringify({ url, status: 403, body: "blocked" }),
        },
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.phases[0].status).toBe("failed");
    const events = store.listEvents(result.id);
    expect(events.some(e => e.type === "phase_failed")).toBe(true);
  });

  it("generates user-facing research report instead of workflow logs", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const result = await runWorkflow({
      store,
      workflow: buildAgentTeamWorkflow("research", "调研黄金价格从2026年6月到9月的趋势，重点分析美联储利率、美元、实际利率、央行购金、地缘风险和机构观点"),
      executor: createTaskWorkflowExecutor(store, {
        researchTools: {
          search: async () => JSON.stringify({
            provider: "fake",
            results: [
              { title: "World Gold Council outlook", url: "https://example.com/wgc", snippet: "央行购金 and geopolitical risk support gold" },
              { title: "Fed rate cut outlook", url: "https://example.com/fed", snippet: "rate cut and lower real yields may support gold" },
              { title: "Dollar risk", url: "https://example.com/dollar", snippet: "strong dollar and higher yields pressure gold" },
            ],
          }),
          fetch: async ({ url }) => JSON.stringify({ url, status: 200, body: `央行购金 地缘风险 降息 lower real yields strong dollar higher yields pressure gold. `.repeat(20) }),
        },
      }),
    });
    finalizeWorkflowArtifacts(store, result);
    const final = store.listArtifacts(result.id).find(a => a.name === "final-report.md");

    expect(result.status).toBe("completed");
    expect(final?.content).toContain("基准判断");
    expect(final?.content).toContain("情景判断");
    expect(final?.content).not.toMatch(/本报告基于 workflow|collect\/verify|来源摘录|前序来源摘要|# 候选来源|# 可信度判断/);
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

  it("runs code workflow with real repository verification hooks via injected commands", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const calls: string[] = [];
    const result = await runWorkflow({
      store,
      workflow: buildAgentTeamWorkflow("code", "验证当前代码变更"),
      executor: createTaskWorkflowExecutor(store, {
        codeTools: {
          exec: async (cmd, args) => {
            const command = [cmd, ...args].join(" ");
            calls.push(command);
            if (command === "git status --short") return { stdout: " M workflows/executors.ts\n", stderr: "", exitCode: 0 };
            if (command === "git diff --stat") return { stdout: " workflows/executors.ts | 10 +++++\n", stderr: "", exitCode: 0 };
            if (command === "git diff --name-only") return { stdout: "workflows/executors.ts\n", stderr: "", exitCode: 0 };
            if (command === "git diff --") return { stdout: "diff --git a/workflows/executors.ts b/workflows/executors.ts\n", stderr: "", exitCode: 0 };
            if (command === "npm run typecheck") return { stdout: "typecheck ok", stderr: "", exitCode: 0 };
            if (command === "npm test") return { stdout: "tests ok", stderr: "", exitCode: 0 };
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      }),
    });
    finalizeWorkflowArtifacts(store, result);

    expect(result.status).toBe("completed");
    expect(calls).toContain("git diff --name-only");
    expect(calls).toContain("npm run typecheck");
    expect(calls).toContain("npm test");
    const final = store.listArtifacts(result.id).find(a => a.name === "final-report.md");
    expect(final?.content).toContain("验证命令全部通过");
  });

  it("runs kb workflow and emits candidate knowledge entries", async () => {
    const store = createWorkflowStore(path.join(dir, "workflow.db"));
    const objective = [
      "Q: 怎么退款？",
      "A: 订单发货前可以在订单页申请退款，发货后请联系客服处理。",
      "Q: 忘记密码怎么办？",
      "A: 可以在登录页点击忘记密码，通过手机号或邮箱重置。",
    ].join("\n");
    const result = await runWorkflow({
      store,
      workflow: buildAgentTeamWorkflow("kb", objective),
      executor: createTaskWorkflowExecutor(store),
    });
    finalizeWorkflowArtifacts(store, result);

    expect(result.status).toBe("completed");
    const artifacts = store.listArtifacts(result.id);
    expect(artifacts.map(a => a.name)).toContain("kb-candidates.json");
    const final = artifacts.find(a => a.name === "final-report.md");
    expect(final?.content).toContain("候选知识库条目");
    expect(final?.content).toContain("怎么退款");
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
