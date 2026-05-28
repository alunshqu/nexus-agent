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
