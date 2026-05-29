import type { BuiltInWorkflowKind } from "./agent-team.js";

export type WorkflowSelection =
  | { mode: "direct"; reason: string; confidence: number }
  | { mode: "workflow"; kind?: BuiltInWorkflowKind; templateId?: string; reason: string; confidence: number };

export function selectWorkflowForTask(input: string): WorkflowSelection {
  const text = input.trim();
  if (!text) return { mode: "direct", reason: "empty input", confidence: 0 };

  if (/脑暴|头脑风暴|多角色|委员会|council|发散|创意|想法|方向/i.test(text)) {
    return { mode: "workflow", templateId: "brainstorm-council", reason: "open-ended ideation benefits from a task template", confidence: 0.86 };
  }

  if (/调研|搜索|查(一下|找|资料)?|竞品|新闻|行情|价格|来源|对比|research|market/i.test(text)) {
    return { mode: "workflow", kind: "research", reason: "research task needs source collection and verification", confidence: 0.84 };
  }

  if (/代码|修改|实现|修复|bug|测试|typecheck|commit|diff|重构|性能优化|code/i.test(text)) {
    return { mode: "workflow", kind: "code", reason: "code task needs inspect/change/verify loop", confidence: 0.82 };
  }

  if (/知识库|入库|问答|FAQ|客服|聚类|置信度|风险标注|kb/i.test(text)) {
    return { mode: "workflow", kind: "kb", reason: "knowledge task needs cleaning, clustering and risk evaluation", confidence: 0.8 };
  }

  if (text.length > 120 || /方案|计划|整理|分析|生成报告|总结/.test(text)) {
    return { mode: "workflow", templateId: "general-task", reason: "complex task benefits from tracked execution", confidence: 0.62 };
  }

  return { mode: "direct", reason: "simple request can be handled directly", confidence: 0.7 };
}
