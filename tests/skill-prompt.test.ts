import { describe, it, expect } from "vitest";
import { buildSkillPromptSection } from "../skills/index.js";

describe("skill prompt injection", () => {
  it("builds a relevant skill prompt section", () => {
    const section = buildSkillPromptSection("用 TDD 修改代码", 2);
    expect(section).toContain("<available_skills>");
    expect(section).toContain("code_change");
    expect(section).not.toContain("kb_ingestion");
  });

  it("returns empty string when no skill matches", () => {
    expect(buildSkillPromptSection("xyz-unmatched", 2)).toBe("");
  });
});
