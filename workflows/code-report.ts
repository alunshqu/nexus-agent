export type CodeChangeReport = {
  summary: string;
  changedFiles: string[];
  validations: string[];
  risks?: string[];
  rollback?: string;
};

export function formatCodeChangeReport(report: CodeChangeReport): string {
  return [
    `变更摘要：${report.summary}`,
    "\n修改文件：",
    ...(report.changedFiles.length ? report.changedFiles.map(f => `- ${f}`) : ["- 无"]),
    "\n验证：",
    ...(report.validations.length ? report.validations.map(v => `- ${v}`) : ["- 未运行"]),
    "\n风险：",
    ...((report.risks?.length ? report.risks : ["未发现明显风险"]).map(r => `- ${r}`)),
    "\n回滚方式：",
    report.rollback ?? "使用 git revert 回滚对应提交",
  ].join("\n");
}
