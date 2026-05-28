import { describe, it, expect } from "vitest";
import { parseSkillDocument, renderSkillForPrompt, selectSkillsForTask, type SkillDefinition } from "../skills/index.js";

const webResearchSkill: SkillDefinition = {
  name: "web_research",
  description: "多来源网络调研",
  whenToUse: ["需要查新闻", "需要多来源验证"],
  steps: ["搜索公开来源", "抓取关键页面", "交叉验证", "输出结论"],
  tools: ["web_search", "web_fetch", "browser_*"],
  successCriteria: ["至少两个来源", "标注时间和链接"],
  riskLevel: "low",
  version: "1.0",
};

const codeChangeSkill: SkillDefinition = {
  name: "code_change",
  description: "TDD 代码修改流程",
  whenToUse: ["需要修改代码", "需要 TDD"],
  steps: ["写失败测试", "实现代码", "运行测试", "提交"],
  tools: ["read_file", "write_file", "edit_file", "bash"],
  successCriteria: ["测试通过", "工作区干净"],
  riskLevel: "medium",
  version: "1.0",
};

describe("structured skills", () => {
  it("parses a markdown skill document", () => {
    const skill = parseSkillDocument(`# web_research

多来源网络调研

## When to use
- 需要查新闻
- 需要多来源验证

## Steps
- 搜索公开来源
- 抓取关键页面

## Tools
- web_search
- web_fetch

## Success criteria
- 至少两个来源

## Risk level
low

## Version
1.0
`);
    expect(skill.name).toBe("web_research");
    expect(skill.whenToUse).toEqual(["需要查新闻", "需要多来源验证"]);
    expect(skill.tools).toEqual(["web_search", "web_fetch"]);
    expect(skill.riskLevel).toBe("low");
  });

  it("renders a compact prompt block", () => {
    const rendered = renderSkillForPrompt(webResearchSkill);
    expect(rendered).toContain("[Skill: web_research]");
    expect(rendered).toContain("When to use");
    expect(rendered).toContain("Success criteria");
  });

  it("selects relevant skills for a task", () => {
    const selected = selectSkillsForTask("用 TDD 模式修改代码并提交", [webResearchSkill, codeChangeSkill], 3);
    expect(selected.map(s => s.name)[0]).toBe("code_change");
  });
});
