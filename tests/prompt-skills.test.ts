import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt.js";
import { PRINCIPLE_CARDS } from "../principles/registry.js";

describe("system prompt skill placement", () => {
  it("places stable skills in the system prompt for cache-friendly reuse", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("[Skill: code_change]");
    expect(prompt).toContain("[Skill: web_research]");
  });

  it("embeds the static principle registry in the system prompt (cached, not per-turn)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("<work_principles>");
    for (const card of PRINCIPLE_CARDS) expect(prompt).toContain(card.id);
    // buildSystemPrompt is deterministic, so the cached prefix stays stable across turns.
    expect(buildSystemPrompt()).toBe(prompt);
  });
});
