import type { WorkflowRun } from "./runner.js";
import type { WorkflowStore } from "./store.js";
import type { WorkflowExecutor, WorkflowExecutorContext, WorkflowExecutorResult } from "./runtime.js";
import { createBrainstormPhaseOutput, generateBrainstormReport } from "./brainstorm-report.js";
import { toolWebFetch, toolWebSearch } from "../tools/web.js";

export type RegisteredWorkflowExecutor = WorkflowExecutor & { id?: string };

type ResearchTools = {
  search: (input: Record<string, unknown>) => Promise<string>;
  fetch: (input: Record<string, unknown>) => Promise<string>;
};

type TaskWorkflowExecutorOptions = {
  researchTools?: ResearchTools;
};

export function createTaskWorkflowExecutor(store: WorkflowStore, options: TaskWorkflowExecutorOptions = {}): RegisteredWorkflowExecutor {
  const researchTools = options.researchTools ?? { search: toolWebSearch, fetch: toolWebFetch };
  return async function taskWorkflowExecutor(context: WorkflowExecutorContext): Promise<WorkflowExecutorResult> {
    const { run, phase, previousOutputs } = context;

    if (run.workflow.templateId === "brainstorm-council") {
      const output = createBrainstormPhaseOutput(run.workflow, phase.name, previousOutputs);
      const artifacts = [{ name: `${phase.name}.md`, contentType: "text/markdown", content: output }];
      if (phase.name === "roadmap") {
        const syntheticRun = { ...run, phases: run.phases.map(p => p.name === phase.name ? { ...p, output } : p) } as WorkflowRun;
        const report = generateBrainstormReport(syntheticRun);
        artifacts.push({ name: "final-report.md", contentType: "text/markdown", content: report.markdown });
      }
      return { output, artifacts };
    }

    if (run.workflow.templateId === "general-task") {
      return phaseOutput("general-task", phase.name, genericOutput(run.workflow.objective, phase.name, previousOutputs));
    }

    if (run.workflow.kind === "research") {
      return executeResearchPhase(run.workflow.objective, phase.name, previousOutputs, researchTools);
    }

    if (run.workflow.kind === "code") {
      return phaseOutput("code", phase.name, codeOutput(run.workflow.objective, phase.name, previousOutputs));
    }

    if (run.workflow.kind === "kb") {
      return phaseOutput("kb", phase.name, kbOutput(run.workflow.objective, phase.name, previousOutputs));
    }

    return phaseOutput("task", phase.name, `阶段 ${phase.name} 已完成。`);
  };
}

export function finalizeWorkflowArtifacts(store: WorkflowStore, run: WorkflowRun): void {
  if (run.workflow.templateId === "brainstorm-council") {
    const existing = store.listArtifacts(run.id).some(a => a.name === "final-report.md");
    if (!existing) {
      const report = generateBrainstormReport(run);
      store.saveArtifact(run.id, "roadmap", "final-report.md", "text/markdown", report.markdown);
    }
  }

  const summary = formatWorkflowProgress(run);
  const existingSummary = store.listArtifacts(run.id).some(a => a.name === "workflow-summary.md");
  if (!existingSummary) store.saveArtifact(run.id, "summary", "workflow-summary.md", "text/markdown", summary);
}

export function formatWorkflowProgress(run: WorkflowRun): string {
  const template = run.workflow.templateId ? `\n- 模板：${run.workflow.templateId}` : "";
  return [
    `# Workflow 进度摘要`,
    "",
    `- ID：${run.id}`,
    `- 类型：${run.workflow.kind}${template}`,
    `- 状态：${run.status}`,
    `- 目标：${run.workflow.objective}`,
    "",
    "## 阶段",
    ...run.phases.map(p => `- ${statusIcon(p.status)} ${p.name} / ${p.owner}${p.error ? ` — ${p.error}` : ""}`),
  ].join("\n");
}

function phaseOutput(prefix: string, phaseName: string, output: string): WorkflowExecutorResult {
  return { output, artifacts: [{ name: `${phaseName}.md`, contentType: "text/markdown", content: output }] };
}

async function executeResearchPhase(objective: string, phaseName: string, previous: Record<string, string>, tools: ResearchTools): Promise<WorkflowExecutorResult> {
  switch (phaseName) {
    case "collect": {
      const searchRaw = await tools.search({ query: objective, max_results: 6 });
      const parsed = parseJsonObject(searchRaw);
      const results = Array.isArray(parsed.results) ? parsed.results.slice(0, 4) : [];
      const fetched: Array<{ title?: string; url?: string; status?: number; excerpt?: string; error?: string }> = [];
      for (const result of results) {
        const url = typeof result?.url === "string" ? result.url : undefined;
        if (!url) continue;
        try {
          const fetchRaw = await tools.fetch({ url });
          const fetchedJson = parseJsonObject(fetchRaw);
          fetched.push({
            title: typeof result.title === "string" ? result.title : undefined,
            url,
            status: typeof fetchedJson.status === "number" ? fetchedJson.status : undefined,
            excerpt: typeof fetchedJson.body === "string" ? fetchedJson.body.slice(0, 1200) : undefined,
          });
        } catch (error) {
          fetched.push({ title: result.title, url, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const output = [
        "# 候选来源与关键事实",
        "",
        `目标：${objective}`,
        `查询时间：${new Date().toISOString()}`,
        "",
        "## 搜索结果",
        formatSearchResults(results),
        "",
        "## 抓取摘录",
        fetched.map((f, i) => [`### ${i + 1}. ${f.title ?? f.url}`, `URL：${f.url ?? "未知"}`, f.error ? `抓取失败：${f.error}` : `状态：${f.status ?? "未知"}\n\n${f.excerpt ?? "无正文摘录"}`].join("\n")).join("\n\n") || "无可抓取来源。",
      ].join("\n");
      return { output, artifacts: [
        { name: "collect.md", contentType: "text/markdown", content: output },
        { name: "sources.json", contentType: "application/json", content: JSON.stringify({ objective, search: parsed, fetched }, null, 2) },
      ] };
    }
    case "verify": {
      const collect = previous.collect ?? "";
      const sourceCount = (collect.match(/^### \d+\./gm) ?? []).length;
      const output = [
        "# 可信度判断和冲突说明",
        "",
        `目标：${objective}`,
        `来源数量：${sourceCount}`,
        "",
        sourceCount >= 2 ? "结论：已具备至少两个候选来源，可进行交叉验证。" : "结论：来源不足，置信度较低，需要继续补充来源。",
        "",
        "## 验证规则",
        "- 优先采用官方文档、项目仓库、权威技术博客。",
        "- 对产品营销文案和个人博客保持谨慎。",
        "- 时间敏感信息以查询时间为准。",
        "- 若来源之间冲突，应在最终报告中显式标注。",
        "",
        "## 前序来源摘要",
        collect.slice(0, 5000) || "无。",
      ].join("\n");
      return phaseOutput("research", "verify", output);
    }
    case "report": {
      const verify = previous.verify ?? "";
      const collect = previous.collect ?? "";
      const output = [
        "# 调研报告",
        "",
        `目标：${objective}`,
        `生成时间：${new Date().toISOString()}`,
        "",
        "## 摘要结论",
        "本报告基于 workflow 的 collect/verify 阶段自动检索与抓取结果生成。关键结论需要结合来源摘录阅读；若涉及最新行情或产品状态，应以后续实时查询为准。",
        "",
        "## 依据与交叉验证",
        verify.slice(0, 4000) || "无验证摘要。",
        "",
        "## 来源摘录",
        collect.slice(0, 6000) || "无来源摘录。",
        "",
        "## 不确定性",
        "- 自动抓取可能遇到页面脚本、登录墙、地区限制或搜索摘要偏差。",
        "- 需要高可靠结论时，应补充官方文档、原始仓库和人工复核。",
      ].join("\n");
      return { output, artifacts: [{ name: "report.md", contentType: "text/markdown", content: output }, { name: "final-report.md", contentType: "text/markdown", content: output }] };
    }
    default:
      return phaseOutput("research", phaseName, `研究阶段 ${phaseName} 已完成。`);
  }
}

function researchOutput(objective: string, phaseName: string, previous: Record<string, string>): string {
  switch (phaseName) {
    case "collect":
      return ["# 候选来源与关键事实", `目标：${objective}`, "", "待执行器接入 web_search/web_fetch 后，本阶段应产出来源 URL、标题、时间和摘要。", "当前占位输出用于保证任务可追踪，不替代真实调研。"].join("\n");
    case "verify":
      return ["# 可信度判断和冲突说明", "", "需要至少两个独立来源交叉验证关键结论。", "前序摘要：", previous.collect ?? "无"].join("\n");
    case "report":
      return ["# 调研报告", "", `目标：${objective}`, "", "结论需附来源、时间和不确定性。", "", previous.verify ?? previous.collect ?? "暂无前序输出"].join("\n");
    default:
      return `研究阶段 ${phaseName} 已完成。`;
  }
}

function codeOutput(objective: string, phaseName: string, previous: Record<string, string>): string {
  switch (phaseName) {
    case "plan": return ["# 执行计划", "", `目标：${objective}`, "", "1. 阅读相关文件定位责任层。", "2. 先补/改回归测试。", "3. 最小实现。", "4. 运行 typecheck/test。", "5. 检查 diff 和风险。"].join("\n");
    case "implement": return ["# 代码变更", "", "本阶段应通过文件工具完成最小必要改动。", "前序计划：", previous.plan ?? "无"].join("\n");
    case "review": return ["# 审查意见", "", "检查点：测试覆盖、风险、回滚方式、是否污染无关抽象。"].join("\n");
    case "verify": return ["# 验证结果", "", "应包含 typecheck/test 输出和最终状态。"].join("\n");
    default: return `代码阶段 ${phaseName} 已完成。`;
  }
}

function kbOutput(objective: string, phaseName: string, previous: Record<string, string>): string {
  switch (phaseName) {
    case "clean": return ["# 干净问答对", "", `目标：${objective}`, "", "清洗寒暄、隐私、低价值和个案内容。"].join("\n");
    case "cluster": return ["# 问题簇", "", "将相似用户问题合并，保留来源追溯。", previous.clean ?? ""].join("\n");
    case "evaluate": return ["# 置信度和风险评分", "", "标注一致性、风险等级、需人工审核项。"].join("\n");
    case "publish": return ["# 候选知识库条目", "", "输出标准问答、适用范围、来源和风险标注。"].join("\n");
    default: return `知识库阶段 ${phaseName} 已完成。`;
  }
}

function genericOutput(objective: string, phaseName: string, previous: Record<string, string>): string {
  switch (phaseName) {
    case "understand": return `# 目标理解\n\n${objective}`;
    case "execute": return `# 执行记录\n\n基于目标推进任务。前序：${previous.understand ?? "无"}`;
    case "deliver": return `# 交付结果\n\n整理结果、风险和下一步。`;
    default: return `阶段 ${phaseName} 已完成。`;
  }
}

function parseJsonObject(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try { return JSON.parse(match[0]); } catch { return {}; }
  }
}

function formatSearchResults(results: any[]): string {
  if (!results.length) return "无搜索结果。";
  return results.map((r, i) => [
    `${i + 1}. ${typeof r.title === "string" ? r.title : "Untitled"}`,
    `   URL：${typeof r.url === "string" ? r.url : "未知"}`,
    typeof r.snippet === "string" ? `   摘要：${r.snippet}` : undefined,
  ].filter(Boolean).join("\n")).join("\n");
}

function statusIcon(status: string): string {
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  if (status === "running") return "🔄";
  if (status === "waiting_approval") return "⏸";
  return "⏳";
}
