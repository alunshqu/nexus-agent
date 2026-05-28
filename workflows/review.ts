export type ReviewMode = "code_change" | "research" | "kb";

export type ReviewChecklist = {
  mode: ReviewMode;
  items: Array<{ id: string; label: string; required: boolean }>;
};

export function buildReviewChecklist(mode: ReviewMode): ReviewChecklist {
  if (mode === "code_change") {
    return {
      mode,
      items: [
        { id: "tests_passed", label: "typecheck/test 已通过", required: true },
        { id: "diff_reviewed", label: "已检查 diff 与风险", required: true },
        { id: "rollback_defined", label: "已说明回滚方式", required: true },
        { id: "committed", label: "已本地提交", required: false },
      ],
    };
  }

  if (mode === "research") {
    return {
      mode,
      items: [
        { id: "sources_verified", label: "至少两个来源已交叉验证", required: true },
        { id: "time_stated", label: "已标注查询时间/数据时间", required: false },
        { id: "uncertainty_stated", label: "已说明不确定性", required: true },
      ],
    };
  }

  return {
    mode,
    items: [
      { id: "source_traceable", label: "知识条目可追溯来源", required: true },
      { id: "confidence_scored", label: "已标注置信度", required: true },
      { id: "risk_flagged", label: "高风险内容已标注", required: true },
    ],
  };
}

export function evaluateReviewChecklist(checklist: ReviewChecklist, results: Record<string, boolean>) {
  const missing = checklist.items.filter(item => item.required && !results[item.id]);
  return { passed: missing.length === 0, missing };
}
