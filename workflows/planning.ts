export type PlanStepKind =
  | "inspect"
  | "test_red"
  | "implement"
  | "test_green"
  | "review"
  | "commit"
  | "search"
  | "fetch_sources"
  | "verify_sources"
  | "synthesize";

export type AgentPlan = {
  mode: "code_change" | "research" | "general";
  objective: string;
  steps: Array<{ kind: PlanStepKind; title: string }>;
  successCriteria: string[];
};

export function buildPlan(objective: string): AgentPlan {
  if (isCodeTask(objective)) {
    return {
      mode: "code_change",
      objective,
      steps: [
        { kind: "inspect", title: "阅读相关代码，确认现有模式" },
        { kind: "test_red", title: "先写或调整测试，得到失败用例" },
        { kind: "implement", title: "实现最小改动" },
        { kind: "test_green", title: "运行 typecheck/test，确保通过" },
        { kind: "review", title: "检查 diff、风险和回归点" },
        { kind: "commit", title: "本地提交变更" },
      ],
      successCriteria: ["测试先失败后通过", "typecheck/test 通过", "git 工作区干净"],
    };
  }

  if (isResearchTask(objective)) {
    return {
      mode: "research",
      objective,
      steps: [
        { kind: "search", title: "搜索公开来源" },
        { kind: "fetch_sources", title: "抓取关键来源内容" },
        { kind: "verify_sources", title: "多来源交叉验证，标注不确定性" },
        { kind: "synthesize", title: "输出结论、依据和来源" },
      ],
      successCriteria: ["至少两个可验证来源", "标注时间和链接", "区分事实与推测"],
    };
  }

  return {
    mode: "general",
    objective,
    steps: [
      { kind: "inspect", title: "明确目标和上下文" },
      { kind: "implement", title: "执行任务" },
      { kind: "review", title: "验证结果" },
    ],
    successCriteria: ["结果满足用户目标", "说明不确定性"],
  };
}

export function renderPlanForReview(plan: AgentPlan): string {
  return [
    `执行计划：${plan.objective}`,
    `模式：${plan.mode}`,
    "步骤：",
    ...plan.steps.map((s, i) => `${i + 1}. ${s.title}`),
    "验收标准：",
    ...plan.successCriteria.map(s => `- ${s}`),
  ].join("\n");
}

function isCodeTask(text: string): boolean {
  return /代码|修改|实现|TDD|测试|typecheck|commit|提交|diff|bug|性能优化/i.test(text);
}

function isResearchTask(text: string): boolean {
  return /调研|搜索|查|趋势|新闻|资料|竞品|行情|价格|来源/i.test(text);
}
