import type Anthropic from "@anthropic-ai/sdk";

const DEFAULT_CORE_TOOLS = new Set([
  "bash",
  "set_cwd",
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "agent_run",
  "agents_run_parallel",
  "tool_search",
]);

export const toolSearchToolSchema: Anthropic.Tool = {
  name: "tool_search",
  description: "Search deferred tools by keyword. Use when a needed tool is not currently available in the active tool set; the result tells which deferred tools should be loaded for the next step.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keyword such as browser, memory, mcp, media, cron, hook, task." },
      max_results: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export function buildToolLoadRequest(query: string, toolNames: string[], limit = 20) {
  return { query, tools: [...toolNames].sort().slice(0, limit) };
}

export function selectCoreTools(toolNames: string[], core = DEFAULT_CORE_TOOLS): string[] {
  return toolNames.filter(name => core.has(name));
}

export function buildToolSearchIndex(toolNames: string[], coreToolNames: string[]) {
  const core = new Set(coreToolNames);
  const deferred = toolNames.filter(name => !core.has(name)).sort();
  return {
    list: () => deferred,
    search: (query: string, limit = 20) => {
      const q = query.toLowerCase();
      return deferred.filter(name => name.toLowerCase().includes(q)).slice(0, limit);
    },
  };
}
