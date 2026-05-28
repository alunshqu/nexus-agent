import { describe, it, expect } from "vitest";
import { createSkillRegistry, DEFAULT_SKILLS } from "../skills/index.js";

describe("skill registry", () => {
  it("loads default skills and searches by task", () => {
    const registry = createSkillRegistry({ loadUserSkills: false });
    expect(registry.list().map(s => s.name)).toEqual(expect.arrayContaining(["web_research", "code_change", "kb_ingestion"]));
    expect(registry.search("用 TDD 修改代码", 2)[0].name).toBe("code_change");
  });

  it("upserts and retrieves skills", () => {
    const registry = createSkillRegistry({ loadUserSkills: false, defaults: [] });
    registry.upsert({
      name: "custom_ops",
      description: "自定义运维技能",
      whenToUse: ["部署", "排障"],
      steps: ["检查状态", "执行命令"],
      tools: ["bash"],
      successCriteria: ["服务恢复"],
      riskLevel: "medium",
      version: "1.0",
    });
    expect(registry.get("custom_ops")?.description).toBe("自定义运维技能");
    expect(registry.search("帮我排障", 1)[0].name).toBe("custom_ops");
  });

  it("exports markdown for a skill", () => {
    const registry = createSkillRegistry({ loadUserSkills: false, defaults: DEFAULT_SKILLS });
    const md = registry.exportMarkdown("web_research");
    expect(md).toContain("# web_research");
    expect(md).toContain("## Steps");
  });
});
