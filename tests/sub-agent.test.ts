import { describe, it, expect, vi } from "vitest";

// ── Sub-agent system unit tests ───────────────────────────────────────────────
// Covers: template CRUD, tool schema generation, runSubAgent flow, parallel execution

// ── Mock the agent template store ─────────────────────────────────────────────

type AgentTemplate = {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  maxIterations?: number;
};

let templates: AgentTemplate[] = [];

function getAgentTemplate(name: string) { return templates.find(t => t.name === name); }
function upsertAgentTemplate(t: AgentTemplate) {
  const idx = templates.findIndex(x => x.name === t.name);
  if (idx >= 0) templates[idx] = t; else templates.push(t);
}
function deleteAgentTemplate(name: string) { templates = templates.filter(t => t.name !== name); }

// ── Mock runAgent ─────────────────────────────────────────────────────────────

type MockRunAgentResult = { text: string; error?: string };
let mockRunAgentResult: MockRunAgentResult = { text: "" };

async function mockRunAgent(_state: any, opts: any) {
  if (mockRunAgentResult.error) throw new Error(mockRunAgentResult.error);
  if (mockRunAgentResult.text) opts.onEvent({ type: "text", delta: mockRunAgentResult.text });
}

// ── Extracted sub-agent logic (mirrors tools/agent.ts) ────────────────────────

async function runSubAgent(agentName: string, task: string) {
  const template = getAgentTemplate(agentName);
  if (!template) return { result: `Unknown agent: ${agentName}`, is_error: true };

  const childState = { id: "test", cwd: "/tmp", running: false, messages: [{ role: "user", content: task }], activeChildren: new Set() };
  const parts: string[] = [];

  try {
    await mockRunAgent(childState, {
      systemPrompt: template.systemPrompt,
      onEvent: (event: any) => { if (event.type === "text") parts.push(event.delta); },
      maxIterations: template.maxIterations ?? 20,
      allowedTools: template.tools,
    });
    return { result: parts.join("").trim() || "子 agent 未返回结果" };
  } catch (error) {
    return { result: `子 agent 执行失败: ${(error as Error).message}`, is_error: true };
  }
}

// ── Tool filtering (mirrors domain/agent.ts) ──────────────────────────────────

function filterAllowedTools(toolNames: string[], allowedTools?: string[]): string[] {
  if (!allowedTools) return toolNames;
  return toolNames.filter(name =>
    allowedTools.some(pattern =>
      pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern
    )
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sub-agent template CRUD", () => {
  beforeEach(() => { templates = []; });

  it("create template", () => {
    upsertAgentTemplate({ name: "test_agent", description: "test", systemPrompt: "you are test" });
    expect(templates).toHaveLength(1);
    expect(getAgentTemplate("test_agent")?.systemPrompt).toBe("you are test");
  });

  it("update existing template", () => {
    upsertAgentTemplate({ name: "test_agent", description: "v1", systemPrompt: "v1" });
    upsertAgentTemplate({ name: "test_agent", description: "v2", systemPrompt: "v2" });
    expect(templates).toHaveLength(1);
    expect(getAgentTemplate("test_agent")?.description).toBe("v2");
  });

  it("delete template", () => {
    upsertAgentTemplate({ name: "a", description: "", systemPrompt: "" });
    upsertAgentTemplate({ name: "b", description: "", systemPrompt: "" });
    deleteAgentTemplate("a");
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("b");
  });

  it("get non-existent returns undefined", () => {
    expect(getAgentTemplate("nope")).toBeUndefined();
  });
});

describe("sub-agent tool filtering", () => {
  const allTools = ["bash", "read_file", "web_search", "web_fetch", "browser_navigate", "browser_screenshot", "browser_click", "memory_search"];

  it("undefined allowedTools returns all", () => {
    expect(filterAllowedTools(allTools, undefined)).toEqual(allTools);
  });

  it("exact match filters correctly", () => {
    expect(filterAllowedTools(allTools, ["web_search", "web_fetch"])).toEqual(["web_search", "web_fetch"]);
  });

  it("wildcard browser_* matches all browser tools", () => {
    expect(filterAllowedTools(allTools, ["browser_*"])).toEqual(["browser_navigate", "browser_screenshot", "browser_click"]);
  });

  it("mixed exact + wildcard", () => {
    const result = filterAllowedTools(allTools, ["web_search", "web_fetch", "browser_*"]);
    expect(result).toEqual(["web_search", "web_fetch", "browser_navigate", "browser_screenshot", "browser_click"]);
  });

  it("memory_* matches memory tools", () => {
    expect(filterAllowedTools(allTools, ["memory_*"])).toEqual(["memory_search"]);
  });

  it("no match returns empty array", () => {
    expect(filterAllowedTools(allTools, ["nonexistent"])).toEqual([]);
  });

  it("empty allowedTools returns empty", () => {
    expect(filterAllowedTools(allTools, [])).toEqual([]);
  });
});

describe("runSubAgent execution", () => {
  beforeEach(() => {
    templates = [
      { name: "searcher", description: "search", systemPrompt: "you search", tools: ["web_search"], maxIterations: 5 },
    ];
    mockRunAgentResult = { text: "" };
  });

  it("returns text from sub-agent", async () => {
    mockRunAgentResult = { text: "search result here" };
    const { result, is_error } = await runSubAgent("searcher", "find news");
    expect(result).toBe("search result here");
    expect(is_error).toBeUndefined();
  });

  it("returns default message when no text output", async () => {
    mockRunAgentResult = { text: "" };
    const { result } = await runSubAgent("searcher", "find news");
    expect(result).toBe("子 agent 未返回结果");
  });

  it("returns error for unknown agent", async () => {
    const { result, is_error } = await runSubAgent("nonexistent", "task");
    expect(is_error).toBe(true);
    expect(result).toContain("Unknown agent");
  });

  it("catches runAgent exceptions", async () => {
    mockRunAgentResult = { text: "", error: "API timeout" };
    const { result, is_error } = await runSubAgent("searcher", "task");
    expect(is_error).toBe(true);
    expect(result).toContain("API timeout");
  });
});

describe("parallel sub-agent execution", () => {
  beforeEach(() => {
    templates = [
      { name: "a", description: "", systemPrompt: "agent a", tools: ["web_search"] },
      { name: "b", description: "", systemPrompt: "agent b", tools: ["bash"] },
    ];
  });

  it("runs multiple agents and collects results", async () => {
    mockRunAgentResult = { text: "done" };
    const tasks = [
      { agent: "a", task: "task1", label: "Agent A" },
      { agent: "b", task: "task2", label: "Agent B" },
    ];
    const results = await Promise.all(tasks.map(t => runSubAgent(t.agent, t.task)));
    expect(results).toHaveLength(2);
    expect(results[0].result).toBe("done");
    expect(results[1].result).toBe("done");
  });

  it("partial failure doesn't block others", async () => {
    templates = [
      { name: "good", description: "", systemPrompt: "ok" },
    ];
    const tasks = [
      { agent: "good", task: "task1" },
      { agent: "missing", task: "task2" },
    ];
    mockRunAgentResult = { text: "success" };
    const results = await Promise.all(tasks.map(t => runSubAgent(t.agent, t.task)));
    expect(results[0].result).toBe("success");
    expect(results[1].is_error).toBe(true);
    expect(results[1].result).toContain("Unknown agent");
  });
});

// Need to import beforeEach
import { beforeEach } from "vitest";
