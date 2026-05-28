import type Anthropic from "@anthropic-ai/sdk";
import type { AgentTemplate } from "../agents/index.js";

export function stableTools<T extends Anthropic.Tool>(tools: T[]): T[] {
  return tools
    .map(tool => tool.name === "agent_run" || tool.name === "agents_run_parallel"
      ? ({ ...tool, description: staticAgentToolDescription(tool.name) } as T)
      : tool)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildAgentRegistryAttachment(templates: AgentTemplate[]): string {
  if (templates.length === 0) return "";
  const lines = [...templates]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `- ${t.name}：${t.description}${t.tools?.length ? `；工具：${t.tools.join(", ")}` : ""}${t.maxIterations ? `；最大迭代：${t.maxIterations}` : ""}`);
  return `<agent_registry>\n可用子 agent：\n${lines.join("\n")}\n</agent_registry>`;
}

function staticAgentToolDescription(name: string): string {
  if (name === "agents_run_parallel") {
    return "并行委托多个子 agent 同时执行独立子任务。适合可以独立执行、互不依赖的子任务。具体可用 agent 见 system/context 中的 <agent_registry>。";
  }
  return "委托专用子 agent 执行子任务。具体可用 agent 见 system/context 中的 <agent_registry>。";
}
