import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt.js";

describe("system prompt skill placement", () => {
  it("places stable skills in the system prompt for cache-friendly reuse", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("[Skill: code_change]");
    expect(prompt).toContain("[Skill: web_research]");
  });
});
