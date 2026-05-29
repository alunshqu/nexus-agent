import type { PrincipleCard } from "./types.js";
import { PRINCIPLE_CARDS } from "./registry.js";

// Static registry rendering for the CACHED system prompt. Deterministic (no per-turn
// input) so it never changes the cache prefix. The model self-selects which principles
// apply each turn from this stable list — there is no per-turn injection downstream.
export function renderPrincipleRegistryForPrompt(cards: PrincipleCard[] = PRINCIPLE_CARDS): string {
  if (cards.length === 0) return "";
  return `<work_principles>\n根据每轮任务情景，主动判断并遵守下列适用准则（mandatory 必须遵守）；不要等用户显式提出。\n\n${cards.map(renderRegistryCard).join("\n\n")}\n</work_principles>`;
}

function renderRegistryCard(card: PrincipleCard): string {
  return [
    `[${card.id}] ${card.title}（${card.level}，适用：${card.appliesTo.join("/")}）`,
    card.summary,
    `必做：${card.requiredActions.join("；")}`,
    `禁止：${card.wrongPatterns.join("；")}`,
  ].join("\n");
}
