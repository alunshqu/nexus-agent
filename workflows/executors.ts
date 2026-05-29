import type { WorkflowRun } from "./runner.js";
import type { WorkflowStore } from "./store.js";
import type { WorkflowExecutor, WorkflowExecutorContext, WorkflowExecutorResult } from "./runtime.js";
import { createBrainstormPhaseOutput, generateBrainstormReport } from "./brainstorm-report.js";

export type RegisteredWorkflowExecutor = WorkflowExecutor & { id?: string };

export function createTaskWorkflowExecutor(store: WorkflowStore): RegisteredWorkflowExecutor {
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
      return phaseOutput("research", phase.name, researchOutput(run.workflow.objective, phase.name, previousOutputs));
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

function statusIcon(status: string): string {
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  if (status === "running") return "🔄";
  if (status === "waiting_approval") return "⏸";
  return "⏳";
}
