import { describe, it, expect } from "vitest";
import { buildSkillPromptSection } from "../skills/index.js";

describe("skill prompt selection helper", () => {
  it("can build a relevant skill prompt section for explicit callers", () => {
    const section = buildSkillPromptSection("用 TDD 修改代码", 2);
    expect(section).toContain("<available_skills>");
    expect(section).toContain("code_change");
  });

  it("returns empty string when no skill matches", () => {
    expect(buildSkillPromptSection("xyz-unmatched", 2)).toBe("");
  });
});
