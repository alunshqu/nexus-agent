import type { WorkflowRun } from "./runner.js";
import type { WorkflowStore } from "./store.js";
import type { WorkflowExecutor, WorkflowExecutorContext, WorkflowExecutorResult } from "./runtime.js";
import { createBrainstormPhaseOutput, generateBrainstormReport } from "./brainstorm-report.js";
import { toolWebFetch, toolWebSearch } from "../tools/web.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

export type RegisteredWorkflowExecutor = WorkflowExecutor & { id?: string };

type ResearchTools = {
  search: (input: Record<string, unknown>) => Promise<string>;
  fetch: (input: Record<string, unknown>) => Promise<string>;
};

type TaskWorkflowExecutorOptions = {
  researchTools?: ResearchTools;
  codeTools?: CodeTools;
};

type CodeTools = {
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

export function createTaskWorkflowExecutor(store: WorkflowStore, options: TaskWorkflowExecutorOptions = {}): RegisteredWorkflowExecutor {
  const researchTools = options.researchTools ?? { search: toolWebSearch, fetch: toolWebFetch };
  const codeTools = options.codeTools ?? { exec: runCommand };
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
      return executeCodePhase(run.workflow.objective, phase.name, previousOutputs, codeTools);
    }

    if (run.workflow.kind === "kb") {
      return executeKbPhase(run.workflow.objective, phase.name, previousOutputs);
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

async function executeCodePhase(objective: string, phaseName: string, previous: Record<string, string>, tools: CodeTools): Promise<WorkflowExecutorResult> {
  switch (phaseName) {
    case "plan": {
      const [status, pkg] = await Promise.all([
        tools.exec("git", ["status", "--short"]),
        readPackageJsonSafe(),
      ]);
      const scripts = pkg?.scripts ? Object.keys(pkg.scripts).map(k => `- ${k}: ${pkg.scripts[k]}`).join("\n") : "未发现 package.json scripts。";
      const output = [
        "# 代码任务执行计划",
        "",
        `目标：${objective}`,
        "",
        "## 仓库状态",
        codeBlock(status.stdout || "工作区无未提交变更。"),
        "",
        "## 可用验证命令",
        scripts,
        "",
        "## 执行策略",
        "- 本 workflow 会真实检查仓库状态、diff、typecheck/test。",
        "- 不会在无补丁/无明确变更输入时假装已经实现代码。",
        "- 若需要模型修改代码，应由主 agent 使用文件工具完成变更后，再由 workflow 验证。",
      ].join("\n");
      return { output, artifacts: [
        { name: "plan.md", contentType: "text/markdown", content: output },
        { name: "repo-status.txt", contentType: "text/plain", content: status.stdout || "" },
      ] };
    }
    case "implement": {
      const [stat, names, diff] = await Promise.all([
        tools.exec("git", ["diff", "--stat"]),
        tools.exec("git", ["diff", "--name-only"]),
        tools.exec("git", ["diff", "--"]),
      ]);
      const hasDiff = Boolean(names.stdout.trim());
      const output = [
        "# 代码变更记录",
        "",
        hasDiff ? "检测到工作区代码变更，进入审查与验证。" : "未检测到代码 diff。本阶段不会伪造实现结果；如果目标要求修改代码，需要先由 agent 文件工具产生实际变更。",
        "",
        "## Diff Stat",
        codeBlock(stat.stdout || "无 diff。"),
        "",
        "## Changed Files",
        codeBlock(names.stdout || "无文件变更。"),
      ].join("\n");
      return { output, artifacts: [
        { name: "implement.md", contentType: "text/markdown", content: output },
        { name: "diff.patch", contentType: "text/plain", content: diff.stdout || "" },
      ] };
    }
    case "review": {
      const changed = await tools.exec("git", ["diff", "--name-only"]);
      const files = changed.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const output = [
        "# 代码审查结果",
        "",
        files.length ? `变更文件数：${files.length}` : "未检测到变更文件。",
        "",
        "## 风险检查",
        ...reviewChangedFiles(files),
        "",
        "## 前序实现摘要",
        (previous.implement ?? "无").slice(0, 3000),
      ].join("\n");
      return phaseOutput("code", "review", output);
    }
    case "verify": {
      const commands = await verificationCommands();
      const results = [] as Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
      for (const command of commands) {
        const [cmd, ...args] = command;
        const r = await tools.exec(cmd, args);
        results.push({ command: [cmd, ...args].join(" "), ...r });
      }
      const failed = results.filter(r => r.exitCode !== 0);
      const output = [
        "# 验证结果",
        "",
        failed.length ? `结论：${failed.length} 个验证命令失败。` : "结论：验证命令全部通过。",
        "",
        ...results.map(r => [`## ${r.command}`, `exitCode: ${r.exitCode}`, "", "stdout:", codeBlock(r.stdout.slice(0, 4000) || "无"), "stderr:", codeBlock(r.stderr.slice(0, 4000) || "无")].join("\n")),
      ].join("\n");
      if (failed.length) throw new Error(`code verification failed: ${failed.map(f => f.command).join(", ")}`);
      return { output, artifacts: [{ name: "verify.md", contentType: "text/markdown", content: output }, { name: "final-report.md", contentType: "text/markdown", content: output }] };
    }
    default:
      return phaseOutput("code", phaseName, `代码阶段 ${phaseName} 已完成。`);
  }
}

async function executeKbPhase(objective: string, phaseName: string, previous: Record<string, string>): Promise<WorkflowExecutorResult> {
  switch (phaseName) {
    case "clean": {
      const pairs = extractQaPairs(objective);
      const cleaned = pairs.map((p, i) => ({ id: `qa_${i + 1}`, question: cleanText(p.question), answer: cleanText(p.answer), source: p.source ?? "user_input" }));
      const output = ["# 干净问答对", "", ...cleaned.map(p => `## ${p.id}\nQ: ${p.question}\nA: ${p.answer}\nSource: ${p.source}`)].join("\n");
      return { output, artifacts: [{ name: "clean.md", contentType: "text/markdown", content: output }, { name: "clean.json", contentType: "application/json", content: JSON.stringify(cleaned, null, 2) }] };
    }
    case "cluster": {
      const pairs = parseCleanPairs(previous.clean ?? objective);
      const clusters = clusterQaPairs(pairs);
      const output = ["# 问题簇", "", ...clusters.map((c, i) => [`## cluster_${i + 1}: ${c.topic}`, ...c.items.map(item => `- ${item.id}: ${item.question}`)].join("\n"))].join("\n");
      return { output, artifacts: [{ name: "cluster.md", contentType: "text/markdown", content: output }, { name: "clusters.json", contentType: "application/json", content: JSON.stringify(clusters, null, 2) }] };
    }
    case "evaluate": {
      const pairs = parseCleanPairs(previous.clean ?? objective);
      const evaluated = pairs.map(p => ({ ...p, confidence: estimateKbConfidence(p), risk: estimateKbRisk(p) }));
      const output = ["# 置信度和风险评分", "", ...evaluated.map(p => `## ${p.id}\n- confidence: ${p.confidence}\n- risk: ${p.risk.level}\n- reason: ${p.risk.reason}`)].join("\n");
      return { output, artifacts: [{ name: "evaluate.md", contentType: "text/markdown", content: output }, { name: "evaluation.json", contentType: "application/json", content: JSON.stringify(evaluated, null, 2) }] };
    }
    case "publish": {
      const pairs = parseCleanPairs(previous.clean ?? objective);
      const entries = pairs.map(p => ({
        title: p.question.slice(0, 80),
        question: p.question,
        answer: p.answer,
        scope: inferKbScope(p),
        confidence: estimateKbConfidence(p),
        risk: estimateKbRisk(p),
        source: p.source,
      }));
      const output = [
        "# 候选知识库条目",
        "",
        ...entries.map((e, i) => [`## ${i + 1}. ${e.title}`, `**问题**：${e.question}`, `**标准回答**：${e.answer}`, `**适用范围**：${e.scope}`, `**置信度**：${e.confidence}`, `**风险**：${e.risk.level} — ${e.risk.reason}`, `**来源**：${e.source}`].join("\n\n")),
      ].join("\n\n");
      return { output, artifacts: [{ name: "publish.md", contentType: "text/markdown", content: output }, { name: "kb-candidates.json", contentType: "application/json", content: JSON.stringify(entries, null, 2) }, { name: "final-report.md", contentType: "text/markdown", content: output }] };
    }
    default:
      return phaseOutput("kb", phaseName, `知识库阶段 ${phaseName} 已完成。`);
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

function codeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

async function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(cmd, args, { cwd: process.cwd(), timeout: 120_000, maxBuffer: 1024 * 1024 * 5 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: any) {
    return { stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? error), exitCode: Number(error?.code ?? 1) };
  }
}

async function readPackageJsonSafe(): Promise<any | undefined> {
  const file = path.join(process.cwd(), "package.json");
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

async function verificationCommands(): Promise<string[][]> {
  const pkg = await readPackageJsonSafe();
  const scripts = pkg?.scripts ?? {};
  const commands: string[][] = [];
  if (scripts.typecheck) commands.push(["npm", "run", "typecheck"]);
  if (scripts.test) commands.push(["npm", "test"]);
  if (!commands.length) commands.push(["git", "diff", "--check"]);
  return commands;
}

function reviewChangedFiles(files: string[]): string[] {
  if (!files.length) return ["- 未检测到实际代码变更；不能视为已实现。"];
  const risks: string[] = [];
  for (const file of files) {
    if (/package-lock\.json|pnpm-lock\.yaml|yarn\.lock/.test(file)) risks.push(`- ${file}: 依赖锁文件变更，需要确认是否必要。`);
    else if (/\.env|secret|credential|key/i.test(file)) risks.push(`- ${file}: 可能涉及敏感配置，需人工确认。`);
    else if (/test|spec/i.test(file)) risks.push(`- ${file}: 测试变更，需确保不是降低断言。`);
    else risks.push(`- ${file}: 常规代码/文档变更，需结合 diff 审查。`);
  }
  return risks;
}

type QaPair = { id: string; question: string; answer: string; source: string };

type RawQaPair = { question: string; answer: string; source?: string };

function extractQaPairs(input: string): RawQaPair[] {
  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pairs: RawQaPair[] = [];
  let currentQ = "";
  let currentA = "";
  for (const line of lines) {
    const q = line.match(/^(?:Q|问|问题)[:：]\s*(.+)$/i);
    const a = line.match(/^(?:A|答|回答)[:：]\s*(.+)$/i);
    if (q) {
      if (currentQ || currentA) pairs.push({ question: currentQ || "未命名问题", answer: currentA || "待补充回答" });
      currentQ = q[1]; currentA = "";
    } else if (a) {
      currentA = currentA ? `${currentA}\n${a[1]}` : a[1];
    } else if (currentQ && !currentA) {
      currentA = line;
    }
  }
  if (currentQ || currentA) pairs.push({ question: currentQ || "未命名问题", answer: currentA || "待补充回答" });
  if (!pairs.length) {
    const chunks = input.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < chunks.length; i++) pairs.push({ question: `候选问题 ${i + 1}`, answer: chunks[i] });
  }
  return pairs.slice(0, 200);
}

function cleanText(text: string): string {
  return text.replace(/\b\d{3}[- ]?\d{4}[- ]?\d{4}\b/g, "[手机号]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/^(你好|您好|谢谢|感谢|在吗|哈喽)[，,。!！\s]*/g, "")
    .trim() || "待补充";
}

function parseCleanPairs(markdown: string): QaPair[] {
  const pairs: QaPair[] = [];
  const blocks = markdown.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const id = block.split(/\r?\n/)[0]?.trim() || `qa_${pairs.length + 1}`;
    const q = block.match(/Q:\s*([^\n]+)/)?.[1]?.trim() ?? "未命名问题";
    const a = block.match(/A:\s*([\s\S]*?)(?:\nSource:|$)/)?.[1]?.trim() ?? "待补充回答";
    const source = block.match(/Source:\s*([^\n]+)/)?.[1]?.trim() ?? "user_input";
    pairs.push({ id, question: q, answer: a, source });
  }
  return pairs.length ? pairs : extractQaPairs(markdown).map((p, i) => ({ id: `qa_${i + 1}`, question: cleanText(p.question), answer: cleanText(p.answer), source: p.source ?? "user_input" }));
}

function clusterQaPairs(pairs: QaPair[]): Array<{ topic: string; items: QaPair[] }> {
  const groups = new Map<string, QaPair[]>();
  for (const pair of pairs) {
    const topic = inferTopic(pair.question);
    groups.set(topic, [...(groups.get(topic) ?? []), pair]);
  }
  return [...groups.entries()].map(([topic, items]) => ({ topic, items }));
}

function inferTopic(question: string): string {
  if (/价格|费用|收费|退款|支付/.test(question)) return "价格/支付";
  if (/发货|物流|配送|到货/.test(question)) return "物流/配送";
  if (/账号|登录|密码|注册/.test(question)) return "账号/登录";
  if (/安装|使用|操作|配置/.test(question)) return "使用/配置";
  if (/售后|保修|退换|投诉/.test(question)) return "售后/服务";
  return question.slice(0, 12) || "其他";
}

function estimateKbConfidence(pair: QaPair): "high" | "medium" | "low" {
  if (pair.answer.length >= 30 && pair.question.length >= 6) return "high";
  if (pair.answer.length >= 10) return "medium";
  return "low";
}

function estimateKbRisk(pair: QaPair): { level: "low" | "medium" | "high"; reason: string } {
  const text = `${pair.question}\n${pair.answer}`;
  if (/医疗|诊断|处方|法律|合同|投资|收益|保证|绝对/.test(text)) return { level: "high", reason: "涉及医疗/法律/投资或绝对化承诺，需人工审核" };
  if (/退款|赔偿|投诉|隐私|个人信息/.test(text)) return { level: "medium", reason: "涉及售后、赔付或隐私，建议人工抽检" };
  return { level: "low", reason: "常规知识条目" };
}

function inferKbScope(pair: QaPair): string {
  return `适用于“${inferTopic(pair.question)}”相关的标准问答场景；不适用于个案承诺或高风险专业建议。`;
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
