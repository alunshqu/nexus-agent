import type { ActivePrinciple } from "./types.js";

export function renderActivePrinciplesForPrompt(principles: ActivePrinciple[]): string {
  if (principles.length === 0) return "";
  return `<active_principles>\n${principles.map(renderPrinciple).join("\n\n")}\n</active_principles>`;
}

function renderPrinciple(principle: ActivePrinciple): string {
  return [
    `[${principle.id}] ${principle.title}`,
    `Level: ${principle.level}`,
    `Summary: ${principle.summary}`,
    principle.matchedTriggers.length ? `Matched triggers: ${principle.matchedTriggers.join(", ")}` : undefined,
    `Required actions:\n${principle.requiredActions.map((action, index) => `${index + 1}. ${action}`).join("\n")}`,
    `Avoid:\n${principle.wrongPatterns.map(pattern => `- ${pattern}`).join("\n")}`,
    `Evaluation must-have: ${principle.evaluation.mustHave.join(", ")}`,
  ].filter(Boolean).join("\n");
}
