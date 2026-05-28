import { searchMemories, getMemoriesByType, findSimilarMemories, type Memory } from "./store.js";

const MAX_MEMORY_TOKENS = Number(process.env.MAX_MEMORY_TOKENS ?? 2000);
const MAX_SKILL_TOKENS = Number(process.env.MAX_SKILL_TOKENS ?? 3000);

/**
 * Memory injection tiers:
 *
 * Tier 1 (System prompt, scope: org):
 *   - Only user_profile type
 *   - Must be stable, long-term facts (preferences, role, identity)
 *   - Rarely changes → cache stays valid
 *   - Strict admission: only explicitly saved by user or high-confidence extraction
 *
 * Tier 2 (Messages tail, before current user message):
 *   - project_knowledge, decision, relevant skill types
 *   - Retrieved by relevance to current message
 *   - Appended at end (model attention is stronger on recent tokens)
 *   - Once injected, never modified (new info appends after)
 *
 * Tier 3 (On-demand via memory_search tool):
 *   - correction and anything else
 *   - Agent decides when to recall
 *   - Zero cost if not needed
 */

export async function retrieveForSystem(): Promise<string> {
  // Tier 1: Only user_profile with explicit source (user said "remember this")
  const core = getMemoriesByType("user_profile")
    .filter(m => m.source === "user_explicit")
    .slice(0, 10);

  if (core.length === 0) return "";
  return core.map(m => `- ${m.content}`).join("\n");
}

export async function retrieveForMessages(userMessage: string): Promise<string> {
  if (!userMessage) return "";

  // Tier 2: project_knowledge + decision + skill, retrieved by relevance.
  // Skills are actionable procedures/capabilities and should be surfaced when they match the task.
  const tailTypes = new Set<Memory["type"]>(["project_knowledge", "decision", "skill"]);
  const byKeyword = searchMemories(userMessage, 20).filter(m => tailTypes.has(m.type));
  const bySimilarity = (await findSimilarMemories(userMessage, 0.3, 20)).filter(m => tailTypes.has(m.type));

  // Merge, deduplicate, respect token budget
  const seen = new Set<string>();
  const relevant: Memory[] = [];
  let tokens = 0;

  for (const m of [...bySimilarity, ...byKeyword]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const limit = m.type === "skill" ? MAX_SKILL_TOKENS : MAX_MEMORY_TOKENS;
    const est = Math.ceil(m.content.length / 3);
    if (tokens + est > limit) continue;
    tokens += est;
    relevant.push(m);
  }

  if (relevant.length === 0) return "";
  return relevant.map(m => {
    const label = m.type === "skill" ? "可用技能" : m.type;
    return `- [${label}] ${m.content}`;
  }).join("\n");
}

// Legacy exports for compatibility
export async function retrieveMemories(userMessage: string) {
  const core = getMemoriesByType("user_profile").filter(m => m.source === "user_explicit").slice(0, 10);
  const relevant = userMessage ? await retrieveForMessages(userMessage).then(text =>
    text ? [{ id: "ctx", content: text, type: "project_knowledge" as const, tags: [], source: "extracted" as const, created_at: 0, updated_at: 0, access_count: 0 }] : []
  ) : [];
  return { core, relevant };
}

export function formatMemoriesForSystemPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";
  return memories.map(m => `- ${m.content}`).join("\n");
}

export function formatMemoriesForContext(memories: Memory[]): string {
  if (memories.length === 0) return "";
  return `[相关记忆]\n${memories.map(m => `- [${m.type}] ${m.content}`).join("\n")}`;
}
