import type Anthropic from "@anthropic-ai/sdk";
import { saveMemory, updateMemory, removeMemory, searchMemories, getActiveMemories, getMemoriesByType, type Memory } from "./store.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("memory_tools");

export const memoryTools: Anthropic.Tool[] = [
  {
    name: "memory_save",
    description: "Save a memory for long-term recall. Use when the user explicitly asks to remember something, or when you discover important preferences, decisions, or project knowledge.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (concise, factual statement)." },
        type: { type: "string", enum: ["user_profile", "project_knowledge", "decision", "skill", "correction"], description: "Memory type." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization." },
      },
      required: ["content", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Search memories by keyword or semantic similarity. Use to recall past decisions, user preferences, or project knowledge.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        type: { type: "string", enum: ["user_profile", "project_knowledge", "decision", "skill", "correction"], description: "Optional: filter by type." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_list",
    description: "List all active memories, optionally filtered by type.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["user_profile", "project_knowledge", "decision", "skill", "correction"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory's content (e.g., when a fact changes).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to update." },
        content: { type: "string", description: "New content." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory that is no longer relevant.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to delete." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export function executeMemoryTool(name: string, input: Record<string, any>): { content: string; is_error?: boolean } {
  try {
    switch (name) {
      case "memory_save": {
        const m = saveMemory(input.content, input.type, { tags: input.tags, source: "user_explicit" });
        logger.info("saved", { type: input.type, memoryId: m.id });
        return { content: `Memory saved (id: ${m.id}, type: ${m.type})` };
      }
      case "memory_search": {
        let results: Memory[];
        if (input.type) {
          results = getMemoriesByType(input.type).filter(m =>
            m.content.toLowerCase().includes((input.query as string).toLowerCase())
          ).slice(0, input.limit ?? 10);
        } else {
          results = searchMemories(input.query, input.limit ?? 10);
        }
        if (results.length === 0) return { content: "No memories found." };
        return { content: JSON.stringify(results.map(m => ({ id: m.id, type: m.type, content: m.content, tags: m.tags, created: new Date(m.created_at).toISOString() })), null, 2) };
      }
      case "memory_list": {
        const memories = input.type ? getMemoriesByType(input.type) : getActiveMemories();
        if (memories.length === 0) return { content: "No memories stored." };
        return { content: JSON.stringify(memories.map(m => ({ id: m.id, type: m.type, content: m.content, tags: m.tags })), null, 2) };
      }
      case "memory_update": {
        updateMemory(input.id, input.content, input.tags);
        return { content: `Memory ${input.id} updated.` };
      }
      case "memory_delete": {
        removeMemory(input.id);
        return { content: `Memory ${input.id} deleted.` };
      }
      default:
        return { content: `Unknown memory tool: ${name}`, is_error: true };
    }
  } catch (e) {
    logger.error("execute_failed", e, { toolName: name });
    return { content: e instanceof Error ? e.message : String(e), is_error: true };
  }
}
