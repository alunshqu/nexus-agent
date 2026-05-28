import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";

export type SkillDefinition = {
  name: string;
  description: string;
  whenToUse: string[];
  steps: string[];
  tools: string[];
  successCriteria: string[];
  riskLevel: "low" | "medium" | "high";
  version?: string;
};

export const DEFAULT_SKILLS: SkillDefinition[] = [
  {
    name: "web_research",
    description: "多来源网络调研与可信度分析",
    whenToUse: ["查新闻、行情、公司、产品、竞品", "需要公开来源交叉验证", "需要标注来源和时间"],
    steps: ["用 web_search 找候选来源", "用 web_fetch 抓取关键页面", "至少交叉验证两个来源", "区分事实、观点和推测", "输出结论、依据、链接和不确定性"],
    tools: ["web_search", "web_fetch", "browser_*"],
    successCriteria: ["关键结论有来源", "时间敏感数据标注查询时间", "明确冲突和不确定性"],
    riskLevel: "low",
    version: "1.0",
  },
  {
    name: "code_change",
    description: "TDD 代码修改、验证和本地提交流程",
    whenToUse: ["需要修改代码", "用户要求 TDD", "需要性能优化、bug 修复或新增模块"],
    steps: ["读取相关文件理解现有模式", "先写失败测试形成红灯", "实现最小代码改动", "运行 typecheck/test 变绿", "检查 diff 和风险", "本地 git commit"],
    tools: ["grep", "read_file", "write_file", "edit_file", "bash"],
    successCriteria: ["测试经历红灯到绿灯", "typecheck/test 通过", "提交信息清晰", "工作区干净"],
    riskLevel: "medium",
    version: "1.0",
  },
  {
    name: "kb_ingestion",
    description: "从 IM 问答中生成候选知识库条目",
    whenToUse: ["IM 问答入知识库", "客户问题和商家回复聚类", "需要评估知识准确性"],
    steps: ["清洗寒暄、隐私和个案", "聚类相似问题", "评估回复一致性和风险", "生成标准问答和适用范围", "输出人工抽检表"],
    tools: ["read_file", "write_file", "bash"],
    successCriteria: ["候选知识可追溯来源", "标注置信度和风险", "高风险内容不自动入库"],
    riskLevel: "medium",
    version: "1.0",
  },
];

const DEFAULT_SKILL_DIR = path.join(os.homedir(), ".agent", "skills");

export function parseSkillDocument(markdown: string): SkillDefinition {
  const lines = markdown.split(/\r?\n/);
  const title = lines.find(l => l.startsWith("# "))?.replace(/^#\s+/, "").trim();
  if (!title) throw new Error("Skill document must start with a # title");

  const description = lines.slice(lines.findIndex(l => l.startsWith("# ")) + 1)
    .find(l => l.trim() && !l.startsWith("## "))?.trim() ?? "";

  const section = (name: string) => {
    const idx = lines.findIndex(l => l.trim().toLowerCase() === `## ${name.toLowerCase()}`);
    if (idx < 0) return [] as string[];
    const body: string[] = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ")) break;
      const item = line.trim().replace(/^[-*]\s+/, "").trim();
      if (item) body.push(item);
    }
    return body;
  };

  const risk = (section("Risk level")[0] ?? "medium").toLowerCase();
  return {
    name: title,
    description,
    whenToUse: section("When to use"),
    steps: section("Steps"),
    tools: section("Tools"),
    successCriteria: section("Success criteria"),
    riskLevel: risk === "low" || risk === "high" ? risk : "medium",
    version: section("Version")[0],
  };
}

export function renderSkillForPrompt(skill: SkillDefinition): string {
  return [
    `[Skill: ${skill.name}]`,
    `Description: ${skill.description}`,
    skill.version ? `Version: ${skill.version}` : undefined,
    `Risk: ${skill.riskLevel}`,
    skill.whenToUse.length ? `When to use:\n${skill.whenToUse.map(s => `- ${s}`).join("\n")}` : undefined,
    skill.steps.length ? `Steps:\n${skill.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : undefined,
    skill.tools.length ? `Tools: ${skill.tools.join(", ")}` : undefined,
    skill.successCriteria.length ? `Success criteria:\n${skill.successCriteria.map(s => `- ${s}`).join("\n")}` : undefined,
  ].filter(Boolean).join("\n");
}

export function skillToMarkdown(skill: SkillDefinition): string {
  return [
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    "## When to use",
    ...skill.whenToUse.map(s => `- ${s}`),
    "",
    "## Steps",
    ...skill.steps.map(s => `- ${s}`),
    "",
    "## Tools",
    ...skill.tools.map(s => `- ${s}`),
    "",
    "## Success criteria",
    ...skill.successCriteria.map(s => `- ${s}`),
    "",
    "## Risk level",
    skill.riskLevel,
    "",
    "## Version",
    skill.version ?? "1.0",
    "",
  ].join("\n");
}

export function selectSkillsForTask(task: string, skills: SkillDefinition[], limit = 3): SkillDefinition[] {
  const queryTokens = tokenize(task);
  return skills
    .map(skill => ({ skill, score: scoreSkill(queryTokens, skill) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map(x => x.skill);
}

export type SkillRegistry = ReturnType<typeof createSkillRegistry>;

export function createSkillRegistry(opts: { dir?: string; defaults?: SkillDefinition[]; loadUserSkills?: boolean } = {}) {
  const dir = opts.dir ?? DEFAULT_SKILL_DIR;
  const defaults = opts.defaults ?? DEFAULT_SKILLS;
  const skills = new Map<string, SkillDefinition>();
  for (const skill of defaults) skills.set(skill.name, skill);

  if (opts.loadUserSkills !== false && existsSync(dir)) {
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md"))) {
      const skill = parseSkillDocument(readFileSync(path.join(dir, file), "utf8"));
      skills.set(skill.name, skill);
    }
  }

  return {
    list: () => [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    get: (name: string) => skills.get(name),
    search: (task: string, limit = 3) => selectSkillsForTask(task, [...skills.values()], limit),
    upsert: (skill: SkillDefinition) => { skills.set(skill.name, skill); },
    save: (skill: SkillDefinition) => {
      mkdirSync(dir, { recursive: true });
      skills.set(skill.name, skill);
      writeFileSync(path.join(dir, `${skill.name}.md`), skillToMarkdown(skill), "utf8");
    },
    exportMarkdown: (name: string) => {
      const skill = skills.get(name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      return skillToMarkdown(skill);
    },
  };
}

export function buildSkillPromptSection(task: string, limit = 3): string {
  const registry = createSkillRegistry({ loadUserSkills: true });
  const skills = registry.search(task, limit);
  if (skills.length === 0) return "";
  return `<available_skills>\n${skills.map(renderSkillForPrompt).join("\n\n")}\n</available_skills>`;
}

function scoreSkill(queryTokens: Set<string>, skill: SkillDefinition): number {
  const text = [skill.name, skill.description, ...skill.whenToUse, ...skill.steps, ...skill.successCriteria].join(" ");
  const tokens = tokenize(text);
  let score = 0;
  for (const token of queryTokens) if (tokens.has(token)) score++;
  return score;
}

function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase()
    .replace(/tdd/g, " tdd 测试 代码 ")
    .replace(/[，。！？、；：,.!?;:()\[\]{}"']/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const chars = [...normalized].filter(ch => /[\p{Script=Han}]/u.test(ch));
  return new Set([...words, ...chars]);
}
