import { createProvider } from "../infra/provider.js";
import { agentConfig } from "../infra/config.js";
import { saveMemory, findSimilarMemories, expireMemory, type Memory } from "./store.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("memory");

const EXTRACT_MODEL = process.env.MEMORY_EXTRACT_MODEL;

export async function extractMemories(userMessage: string, assistantResponse: string, sessionId: string): Promise<Memory[]> {
  const transcript = `User: ${userMessage}\n\nAssistant: ${assistantResponse}`;

  try {
    const provider = createProvider({
      type: agentConfig.current.type,
      apiKey: agentConfig.current.apiKey,
      baseURL: agentConfig.current.baseURL,
      model: EXTRACT_MODEL ?? (agentConfig.current.type === "anthropic" ? "claude-haiku-4-5-20251001" : agentConfig.current.model),
      maxTokens: 1000,
    });

    const { content } = await provider.stream({
      systemPrompt: `你是一个记忆提取器。从对话中提取值得长期记住的信息。

只提取以下类型：
- user_profile: 用户的偏好、习惯、角色、技能
- project_knowledge: 项目相关的技术决策、架构、约定
- decision: 重要决策及其原因
- correction: 用户纠正的错误认知

输出 JSON 数组，每条记忆一个对象：
[{"content": "...", "type": "...", "tags": ["..."]}]

如果没有值得记住的信息，返回空数组 []。
不要记录临时性的、显而易见的、或者纯操作性的信息。`,
      messages: [{ role: "user", content: `从以下对话中提取记忆：\n\n${transcript.slice(0, 5000)}` }],
      tools: [],
      onText: () => {},
    });

    const text = content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const items = JSON.parse(match[0]) as Array<{ content: string; type: string; tags?: string[] }>;
    const saved: Memory[] = [];

    for (const item of items) {
      if (!item.content || !item.type) continue;

      // Dedup: check if similar memory already exists
      const similar = await findSimilarMemories(item.content, 0.6, 5);
      if (similar.length > 0) {
        const best = similar[0];
        if (jaccard(item.content, best.content) > 0.8) continue;
        if (item.type === "correction" || item.type === "user_profile") {
          expireMemory(best.id);
        }
      }

      const memory = saveMemory(item.content, item.type as Memory["type"], {
        tags: item.tags,
        sessionId,
        source: "extracted",
      });
      saved.push(memory);
    }

    if (saved.length > 0) logger.info("extracted", { count: saved.length, sessionId });
    return saved;
  } catch (e) {
    logger.error("extraction_failed", e, { sessionId });
    return [];
  }
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}
