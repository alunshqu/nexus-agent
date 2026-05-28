import { describe, it, expect } from "vitest";

// ── Tool Selection Eval ───────────────────────────────────────────────────────
// Verifies that the model selects the correct tool for given user inputs.
// Requires live API call. Run with: EVAL=1 npx vitest run tests/eval-tool-selection.test.ts
// Optionally specify provider: EVAL=1 EVAL_PROVIDER=openai|anthropic

const SKIP = !process.env.EVAL;

type EvalCase = {
  input: string;
  expectedTool: string[];  // tool name(s) that should be called (empty = no tool)
  description: string;
};

const cases: EvalCase[] = [
  {
    input: "帮我搜索一下今天的科技新闻，同时查一下竞品最近的动态",
    expectedTool: ["task_create", "agent_run", "web_search"],
    description: "多源搜索任务应该用 task_create 或 agent_run",
  },
  {
    input: "1+1等于几",
    expectedTool: [],
    description: "简单问题不应该调用任何工具",
  },
  {
    input: "看一下当前目录有什么文件",
    expectedTool: ["list_dir", "bash"],
    description: "查看目录应该用 list_dir 或 bash",
  },
  {
    input: "搜索一下 Tavily API 的文档",
    expectedTool: ["web_search"],
    description: "单次搜索应该直接用 web_search",
  },
  {
    input: "帮我把工作目录切换到 /Users/cass/other-project",
    expectedTool: ["set_cwd"],
    description: "切换目录应该用 set_cwd",
  },
  {
    input: "每天早上9点帮我搜索科技新闻并总结",
    expectedTool: ["cron_add"],
    description: "定时任务应该用 cron_add",
  },
  {
    input: "用 web_researcher 帮我深度调研一下 AI agent 框架的现状，对比主流方案",
    expectedTool: ["task_create", "agent_run"],
    description: "深度调研应该用 task_create 或 agent_run",
  },
  {
    input: "查一下 server.ts 的第50行到第80行",
    expectedTool: ["read_file", "grep"],
    description: "读文件指定行应该用 read_file 或 grep 定位",
  },
  {
    input: "在代码里搜索 handleMessage 函数",
    expectedTool: ["grep"],
    description: "搜索代码应该用 grep",
  },
];

// ── Model caller ──────────────────────────────────────────────────────────────

async function callModelForToolChoice(input: string): Promise<string[]> {
  const { buildSystemPrompt } = await import("../prompt.js");
  const { createProvider } = await import("../infra/provider.js");
  const { agentConfig } = await import("../infra/config.js");
  const { tools } = await import("../tools/index.js");
  const { browserTools } = await import("../tools/browser.js");
  const { systemTools } = await import("../tools/system.js");

  const allTools = [...tools, ...browserTools, ...systemTools];
  const systemPrompt = buildSystemPrompt();

  const provider = createProvider({
    type: agentConfig.current.type,
    apiKey: agentConfig.current.apiKey,
    baseURL: agentConfig.current.baseURL,
    model: agentConfig.current.model,
  });

  const { stopReason, content } = await provider.stream({
    systemPrompt,
    messages: [{ role: "user", content: input }],
    tools: allTools,
    onText: () => {},
  });

  if (stopReason === "end_turn") return [];
  return content
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => b.name);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("tool selection eval", () => {
  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    it(c.description, async () => {
      const actualTools = await callModelForToolChoice(c.input);

      if (c.expectedTool.length === 0) {
        expect(actualTools).toHaveLength(0);
      } else {
        const firstTool = actualTools[0];
        const match = c.expectedTool.includes(firstTool);
        if (match) passed++; else failed++;
        expect(
          match,
          `Input: "${c.input}"\nExpected: ${c.expectedTool.join("|")}\nActual: ${actualTools.join(", ") || "(no tool)"}`
        ).toBe(true);
      }
    }, 60000);
  }
});

export { cases, EvalCase };
