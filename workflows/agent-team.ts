export type AgentTeamKind = "research" | "code" | "kb" | "brainstorm";

export type AgentTeamWorkflow = {
  kind: AgentTeamKind;
  objective: string;
  roles: Array<{ name: string; responsibility: string }>;
  phases: Array<{ name: string; owner: string; output: string; timeoutMs?: number; maxAttempts?: number }>;
};

export function buildAgentTeamWorkflow(kind: AgentTeamKind, objective: string): AgentTeamWorkflow {
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

  if (kind === "brainstorm") {
    return {
      kind,
      objective,
      roles: [
        { name: "educator", responsibility: "从教育制度、终身成长和人才培养角度提出机会" },
        { name: "scientist", responsibility: "从科学发现、知识生产和验证机制角度提出机会" },
        { name: "teacher", responsibility: "从一线教学、课堂和个体陪伴角度提出机会" },
        { name: "student", responsibility: "从学习体验、动机、身份探索和创造表达角度提出机会" },
        { name: "elder", responsibility: "从晚年尊严、陪伴、记忆和代际连接角度提出机会" },
        { name: "doctor", responsibility: "从连续健康管理、预防医学和医患协同角度提出机会" },
        { name: "entrepreneur", responsibility: "从商业化、MVP、增长和一人公司角度提出机会" },
        { name: "skeptic", responsibility: "专门寻找风险、伪需求、伦理问题和不可落地点" },
        { name: "architect", responsibility: "把高潜想法转成可执行系统架构和路线图" },
      ],
      phases: [
        { name: "observe", owner: "educator", output: "多角色痛点和世界变化观察" },
        { name: "diverge", owner: "scientist", output: "大胆、高潜、跨学科想法池" },
        { name: "challenge", owner: "skeptic", output: "关键反驳、风险和淘汰理由" },
        { name: "converge", owner: "entrepreneur", output: "收敛后的高潜方向排序" },
        { name: "prototype", owner: "architect", output: "首个可构建 MVP 和系统设计" },
        { name: "roadmap", owner: "architect", output: "30/60/90 天落地路线图和最终报告" },
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
    `Kind: ${workflow.kind}`,
    "Roles:",
    ...workflow.roles.map(r => `- ${r.name}: ${r.responsibility}`),
    "Phases:",
    ...workflow.phases.map((p, i) => `${i + 1}. ${p.name} / ${p.owner} → ${p.output}`),
  ].join("\n");
}
