import type { ActivePrinciple, PrincipleCard, PrincipleTaskType } from "./types.js";
import { PRINCIPLE_CARDS } from "./registry.js";

export function classifyTask(message: string): Set<PrincipleTaskType> {
  const text = normalize(message);
  const types = new Set<PrincipleTaskType>(["general"]);

  if (hasAny(text, ["修", "改", "实现", "新增", "代码", "测试", "typecheck", "commit", "优化", "重构"])) types.add("code_change");
  if (hasAny(text, ["bug", "异常", "报错", "失败", "不对", "老是", "复现", "修复", "为啥", "为什么"])) types.add("bug_fix");
  if (hasAny(text, ["工具", "tool", "调用", "cancel", "cancle", "parallel", "缓存", "token", "runtime", "dispatch", "执行链路", "agent"])) types.add("runtime_issue");
  if (hasAny(text, ["你", "agent", "助手", "模型", "llm", "处理", "表现", "行为"]) && hasAny(text, ["不对", "错", "慢", "纠正", "应该", "不要", "为什么", "咋" ])) types.add("agent_self_correction");
  if (hasAny(text, ["反馈", "沉淀", "经验", "准则", "守则", "流程", "机制", "评价", "后续", "下次", "闭环"])) types.add("feedback_learning");
  if (hasAny(text, ["查", "搜索", "新闻", "价格", "竞品", "资料", "行情"])) types.add("research");

  return types;
}

export function selectPrinciplesForTask(message: string, cards: PrincipleCard[] = PRINCIPLE_CARDS, limit = 6): ActivePrinciple[] {
  const text = normalize(message);
  const taskTypes = classifyTask(message);

  return cards
    .map(card => {
      const typeScore = card.appliesTo.some(t => taskTypes.has(t)) ? 3 : 0;
      const matchedTriggers = card.triggers.filter(trigger => trigger === "*" || text.includes(normalize(trigger)));
      const triggerScore = matchedTriggers.includes("*") ? 1 : matchedTriggers.length * 2;
      const requiredForGeneral = card.id === "P-PRINCIPLE-ACTIVE-RETRIEVAL" ? 10 : 0;
      const score = requiredForGeneral + typeScore + triggerScore;
      return { ...card, score, matchedTriggers };
    })
    .filter(card => card.score > 0)
    .sort((a, b) => b.score - a.score || levelWeight(b.level) - levelWeight(a.level) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some(needle => text.includes(normalize(needle)));
}

function levelWeight(level: string): number {
  return level === "mandatory" ? 2 : 1;
}
