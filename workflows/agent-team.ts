export type BuiltInWorkflowKind = "research" | "code" | "kb";
export type AgentTeamKind = BuiltInWorkflowKind | "task";

export type AgentTeamWorkflow = {
  kind: AgentTeamKind;
  templateId?: string;
  objective: string;
  roles: Array<{ name: string; responsibility: string }>;
  phases: Array<{ name: string; owner: string; output: string; timeoutMs?: number; maxAttempts?: number }>;
};

export function buildAgentTeamWorkflow(kind: BuiltInWorkflowKind, objective: string): AgentTeamWorkflow {
  if (kind === "research") {
    return {
      kind,
      objective,
      roles: [
        { name: "researcher", responsibility: "搜索和抓取公开来源" },
        { name: "verifier", responsibility: "交叉验证来源、识别冲突和不确定性" },
        { name: "writer", responsibility: "整合结论、依据和来源" },
      ],
      phases: [
        { name: "collect", owner: "researcher", output: "候选来源与关键事实" },
        { name: "verify", owner: "verifier", output: "可信度判断和冲突说明" },
        { name: "report", owner: "writer", output: "最终调研报告" },
      ],
    };
  }

  if (kind === "code") {
    return {
      kind,
      objective,
      roles: [
        { name: "planner", responsibility: "拆解任务和定义验收标准" },
        { name: "implementer", responsibility: "按 TDD 实现代码" },
        { name: "reviewer", responsibility: "检查 diff、风险和设计一致性" },
        { name: "tester", responsibility: "运行测试和验证结果" },
      ],
      phases: [
        { name: "plan", owner: "planner", output: "执行计划" },
        { name: "implement", owner: "implementer", output: "代码变更" },
        { name: "review", owner: "reviewer", output: "审查意见" },
        { name: "verify", owner: "tester", output: "测试结果" },
      ],
    };
  }

  return {
    kind,
    objective,
    roles: [
      { name: "cleaner", responsibility: "清洗 IM 问答数据" },
      { name: "clusterer", responsibility: "聚类相似问题" },
      { name: "evaluator", responsibility: "评估一致性和风险" },
      { name: "editor", responsibility: "生成候选知识" },
    ],
    phases: [
      { name: "clean", owner: "cleaner", output: "干净问答对" },
      { name: "cluster", owner: "clusterer", output: "问题簇" },
      { name: "evaluate", owner: "evaluator", output: "置信度和风险评分" },
      { name: "publish", owner: "editor", output: "候选知识库条目" },
    ],
  };
}

export function renderAgentTeamWorkflow(workflow: AgentTeamWorkflow): string {
  return [
    `Agent Team Workflow: ${workflow.objective}`,
    `Kind: ${workflow.kind}${workflow.templateId ? ` / Template: ${workflow.templateId}` : ""}`,
    "Roles:",
    ...workflow.roles.map(r => `- ${r.name}: ${r.responsibility}`),
    "Phases:",
    ...workflow.phases.map((p, i) => `${i + 1}. ${p.name} / ${p.owner} → ${p.output}`),
  ].join("\n");
}
