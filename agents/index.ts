import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { invalidateSystemPrompt } from "../prompt.js";

export type AgentTemplate = {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  maxIterations?: number;
};

const AGENTS_PATH = path.join(os.homedir(), ".agent", "agents.json");

const DEFAULT_TEMPLATES: AgentTemplate[] = [
  {
    name: "search_agent",
    description: "专门负责网络搜索和信息收集的 agent，适合需要大量搜索、汇总网络信息的子任务",
    systemPrompt: `你是一个专业的信息搜索助手。
你的任务是通过网络搜索收集准确、全面的信息，并以结构化的方式返回结果。

规则：
- 优先使用 web_search 搜索，再用 web_fetch 获取详细内容
- 搜索多个角度，确保信息全面
- 直接返回搜索结果和关键信息，不需要额外解释
- 如果搜索结果不足，尝试不同的搜索词`,
    tools: ["web_search", "web_fetch"],
    maxIterations: 10,
  },
];

function loadTemplates(): AgentTemplate[] {
  try {
    if (existsSync(AGENTS_PATH)) return JSON.parse(readFileSync(AGENTS_PATH, "utf8"));
  } catch {}
  return DEFAULT_TEMPLATES;
}

function saveTemplates(templates: AgentTemplate[]) {
  mkdirSync(path.dirname(AGENTS_PATH), { recursive: true });
  writeFileSync(AGENTS_PATH, JSON.stringify(templates, null, 2), "utf8");
}

export let agentTemplates: AgentTemplate[] = loadTemplates().sort((a, b) => a.name.localeCompare(b.name));

export function getAgentTemplate(name: string): AgentTemplate | undefined {
  return agentTemplates.find(t => t.name === name);
}

export function upsertAgentTemplate(template: AgentTemplate) {
  const idx = agentTemplates.findIndex(t => t.name === template.name);
  if (idx >= 0) agentTemplates[idx] = template;
  else agentTemplates.push(template);
  agentTemplates.sort((a, b) => a.name.localeCompare(b.name));
  saveTemplates(agentTemplates);
  invalidateSystemPrompt();
}

export function deleteAgentTemplate(name: string) {
  agentTemplates = agentTemplates.filter(t => t.name !== name).sort((a, b) => a.name.localeCompare(b.name));
  saveTemplates(agentTemplates);
  invalidateSystemPrompt();
}

export function getAgentToolSchema(): Anthropic.Tool {
  const agentNames = agentTemplates.map(t => t.name);
  return {
    name: "agent_run",
    description: `委托专用子 agent 执行子任务。具体可用 agent 见 system/context 中的 <agent_registry>。`,
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: agentNames.length ? agentNames : ["_none"], description: "子 agent 名称" },
        task: { type: "string", description: "给子 agent 的任务描述，要具体清晰" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
  };
}

export function getAgentsParallelToolSchema(): Anthropic.Tool {
  const agentNames = agentTemplates.map(t => t.name);
  return {
    name: "agents_run_parallel",
    description: `并行委托多个子 agent 同时执行独立子任务。适合可以独立执行、互不依赖的子任务。具体可用 agent 见 system/context 中的 <agent_registry>。`,
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "并行执行的任务列表",
          items: {
            type: "object",
            properties: {
              agent: { type: "string", enum: agentNames.length ? agentNames : ["_none"], description: "子 agent 名称" },
              task: { type: "string", description: "任务描述" },
              label: { type: "string", description: "任务标签，用于区分结果" },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  };
}
