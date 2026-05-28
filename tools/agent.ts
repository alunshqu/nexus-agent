import type Anthropic from "@anthropic-ai/sdk";
import type { SessionState } from "../domain/types.js";
import { createSession } from "../infra/session.js";
import { agentConfig } from "../infra/config.js";
import { createLogger } from "../infra/logger.js";
import { getAgentTemplate, getAgentToolSchema, getAgentsParallelToolSchema, upsertAgentTemplate, deleteAgentTemplate, agentTemplates } from "../agents/index.js";

const logger = createLogger("agent_tool");

export { getAgentToolSchema, getAgentsParallelToolSchema };

export function getAgentManageToolSchemas(): Anthropic.Tool[] {
  return [
    {
      name: "agent_create",
      description: "创建或更新子 agent 模板",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "模板名称（英文下划线）" },
          description: { type: "string", description: "描述，主 agent 用来判断何时调用" },
          systemPrompt: { type: "string", description: "子 agent 的 system prompt" },
          tools: { type: "array", items: { type: "string" }, description: "允许的工具名列表，不传=全部" },
          maxIterations: { type: "number", description: "最大迭代次数，默认 20" },
        },
        required: ["name", "description", "systemPrompt"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_delete",
      description: "删除子 agent 模板",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "要删除的模板名称" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_list",
      description: "列出所有子 agent 模板",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

async function runSubAgent(agentName: string, task: string): Promise<{ label?: string; result: string; is_error?: boolean }> {
  const template = getAgentTemplate(agentName);
  if (!template) return { result: `Unknown agent: ${agentName}`, is_error: true };

  const childState = createSession();
  childState.messages.push({ role: "user", content: task });
  const parts: string[] = [];

  const { runAgent } = await import("../domain/agent.js");
  try {
    await runAgent(childState, {
      provider: agentConfig.provider,
      systemPrompt: template.systemPrompt,
      onEvent: (event) => {
        if (event.type === "text") parts.push(event.delta);
        if (event.type === "error") logger.error("sub_agent_event_error", new Error(event.message), { agentName });
      },
      maxIterations: template.maxIterations ?? 20,
      allowedTools: template.tools,
    });
    logger.info("sub_agent_result", { agentName, partsCount: parts.length, resultLength: parts.join("").length, allowedTools: template.tools });
    return { result: parts.join("").trim() || "子 agent 未返回结果" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: `子 agent 执行失败: ${message}`, is_error: true };
  }
}

export async function executeAgentManageTool(
  _parentState: SessionState,
  name: string,
  input: Record<string, unknown>
): Promise<{ content: string; is_error?: boolean }> {
  if (name === "agent_list") {
    if (!agentTemplates.length) return { content: "暂无子 agent 模板" };
    return { content: agentTemplates.map(t => `${t.name}：${t.description}`).join("\n") };
  }
  if (name === "agent_create") {
    const template = {
      name: String(input.name ?? ""),
      description: String(input.description ?? ""),
      systemPrompt: String(input.systemPrompt ?? ""),
      tools: Array.isArray(input.tools) ? input.tools as string[] : undefined,
      maxIterations: input.maxIterations ? Number(input.maxIterations) : undefined,
    };
    if (!template.name || !template.systemPrompt) return { content: "name 和 systemPrompt 不能为空", is_error: true };
    upsertAgentTemplate(template);
    logger.info("agent_template_created", { name: template.name });
    return { content: `子 agent 模板 "${template.name}" 已创建/更新` };
  }
  if (name === "agent_delete") {
    const agentName = String(input.name ?? "");
    if (!agentTemplates.find(t => t.name === agentName)) return { content: `未找到模板：${agentName}`, is_error: true };
    deleteAgentTemplate(agentName);
    logger.info("agent_template_deleted", { name: agentName });
    return { content: `子 agent 模板 "${agentName}" 已删除` };
  }
  return { content: `Unknown agent manage tool: ${name}`, is_error: true };
}

export async function executeAgentTool(
  _parentState: SessionState,
  input: Record<string, unknown>
): Promise<{ content: string; is_error?: boolean }> {
  const agentName = String(input.agent ?? "");
  const task = String(input.task ?? "");

  logger.info("sub_agent_start", { agentName, taskLength: task.length });
  const { result, is_error } = await runSubAgent(agentName, task);
  if (is_error) {
    logger.error("sub_agent_failed", new Error(result), { agentName });
  } else {
    logger.info("sub_agent_done", { agentName, resultLength: result.length });
  }
  return { content: result, is_error };
}

export async function executeAgentsParallelTool(
  _parentState: SessionState,
  input: Record<string, unknown>
): Promise<{ content: string; is_error?: boolean }> {
  const tasks = input.tasks as Array<{ agent: string; task: string; label?: string }>;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { content: "tasks 不能为空", is_error: true };
  }

  logger.info("parallel_agents_start", { count: tasks.length, agents: tasks.map(t => t.agent) });

  const results = await Promise.all(
    tasks.map(async (t) => {
      const { result, is_error } = await runSubAgent(t.agent, t.task);
      return { label: t.label ?? t.agent, result, is_error };
    })
  );

  const hasError = results.some(r => r.is_error);
  const content = results
    .map(r => `## ${r.label}${r.is_error ? " [失败]" : ""}\n${r.result}`)
    .join("\n\n");

  logger.info("parallel_agents_done", { count: results.length, hasError });
  return { content, is_error: hasError };
}
