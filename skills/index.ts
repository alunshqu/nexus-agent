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

export function selectSkillsForTask(task: string, skills: SkillDefinition[], limit = 3): SkillDefinition[] {
  const queryTokens = tokenize(task);
  return skills
    .map(skill => ({ skill, score: scoreSkill(queryTokens, skill) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map(x => x.skill);
}

function scoreSkill(queryTokens: Set<string>, skill: SkillDefinition): number {
  const text = [skill.name, skill.description, ...skill.whenToUse, ...skill.steps, ...skill.successCriteria].join(" ");
  const tokens = tokenize(text);
  let score = 0;
  for (const token of queryTokens) if (tokens.has(token)) score++;
  return score;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase()
    .replace(/[，。！？、；：,.!?;:()\[\]{}"']/g, " ")
    .split(/\s+/)
    .filter(Boolean));
}
