import type Anthropic from "@anthropic-ai/sdk";
import type { SessionState } from "../domain/types.js";
import { agentConfig, applyConfig, upsertProvider } from "../infra/config.js";
import { addMcpServer, removeMcpServer, getMcpStatus, reconnectAll } from "../infra/mcp.js";
import { fetchModels } from "../infra/provider.js";
import { invalidateSystemPrompt } from "../prompt.js";
import { createLogger } from "../infra/logger.js";
import { listCrons, addCron, deleteCron, updateCron, getCron } from "../infra/cron.js";
import { reloadHooks } from "../infra/hooks.js";
import { createTask, getTask, getSessionTasks, addSubAgent, cancelTask, getPendingTasks, getCompletedTasks, startSubAgent, completeSubAgent, failSubAgent } from "../infra/task.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

const logger = createLogger("system_tool");
const HOOKS_PATH = path.join(os.homedir(), ".agent", "hooks.json");

export const systemTools: Anthropic.Tool[] = [
  {
    name: "system_set_model",
    description: "切换当前使用的模型。可以切换模型名称，或切换到不同的 provider。",
    input_schema: {
      type: "object",
      properties: {
        model: { type: "string", description: "模型名称，如 claude-opus-4-7、gpt-4o、deepseek-chat" },
        providerId: { type: "string", description: "可选，切换到指定 provider ID" },
      },
      required: ["model"],
      additionalProperties: false,
    },
  },
  {
    name: "system_list_providers",
    description: "列出所有已配置的 provider 和当前使用的模型",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "system_mcp_add",
    description: "添加并连接一个 MCP server",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "server 名称" },
        type: { type: "string", enum: ["streamable-http", "sse", "stdio"], description: "连接类型" },
        url: { type: "string", description: "HTTP 类型的 URL" },
        command: { type: "string", description: "stdio 类型的命令" },
        args: { type: "array", items: { type: "string" }, description: "stdio 命令参数" },
      },
      required: ["name", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "system_mcp_remove",
    description: "断开并移除一个 MCP server",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "要移除的 server 名称" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "send_media",
    description: "通过当前渠道发送多媒体文件（图片、文件、视频、语音）给用户。仅在支持多媒体的渠道（如企业微信）中可用。文件必须是本地路径。",
    input_schema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "本地文件路径，绝对路径" },
        mediaType: { type: "string", enum: ["image", "file", "video", "voice"], description: "媒体类型" },
        filename: { type: "string", description: "可选，发送时显示的文件名" },
      },
      required: ["filePath", "mediaType"],
      additionalProperties: false,
    },
  },
  {
    name: "system_list_models",
    description: "列出当前 provider 支持的所有模型",
    input_schema: {
      type: "object",
      properties: {
        providerId: { type: "string", description: "可选，指定 provider ID，默认用当前 provider" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "system_mcp_list",
    description: "列出所有 MCP server 及其连接状态和工具数量",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cron_list",
    description: "列出所有定时任务",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cron_add",
    description: "创建一个定时任务，按 cron 表达式定时让 agent 执行指定任务。结果自动推送到当前会话渠道。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称" },
        cron: { type: "string", description: "标准5字段 cron 表达式，如 '0 9 * * *'（每天9点）" },
        task: { type: "string", description: "到时间后发给 agent 的任务描述" },
      },
      required: ["name", "cron", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "cron_delete",
    description: "删除一个定时任务",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id（前缀匹配）或任务名称" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "cron_toggle",
    description: "启用或暂停一个定时任务",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id（前缀匹配）或任务名称" },
        enabled: { type: "boolean", description: "true 启用，false 暂停" },
      },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "hook_list",
    description: "列出当前配置的所有 hooks",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hook_set",
    description: "设置一个 hook，在 agent 生命周期的指定节点执行 shell 命令",
    input_schema: {
      type: "object",
      properties: {
        event: { type: "string", enum: ["before_message", "after_tool", "on_done", "on_error"], description: "触发时机" },
        command: { type: "string", description: "要执行的 shell 命令或脚本路径" },
        timeout_ms: { type: "number", description: "可选，超时毫秒数，默认 10000" },
      },
      required: ["event", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "hook_delete",
    description: "删除一个 hook",
    input_schema: {
      type: "object",
      properties: {
        event: { type: "string", enum: ["before_message", "after_tool", "on_done", "on_error"] },
      },
      required: ["event"],
      additionalProperties: false,
    },
  },
  {
    name: "task_create",
    description: "创建一个后台异步任务，子 agent 在后台执行，主 agent 立即继续。完成后结果会推送给用户。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称" },
        sub_agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent: { type: "string", description: "子 agent 模板名称" },
              task: { type: "string", description: "给子 agent 的任务描述" },
            },
            required: ["agent", "task"],
          },
          description: "要执行的子 agent 列表",
        },
        isolation: { type: "string", enum: ["none", "worktree"], description: "资源隔离模式。worktree 为写入任务创建独立 git 分支，防止并发冲突。默认 none。" },
      },
      required: ["name", "sub_agents"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    description: "查询后台任务的状态和进度",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID，不传则列出所有任务" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "task_cancel",
    description: "取消一个正在执行的后台任务",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "要取消的任务 ID" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

export async function executeSystemTool(
  name: string,
  input: Record<string, unknown>,
  state?: SessionState
): Promise<{ content: string; is_error?: boolean }> {
  try {
    switch (name) {
      case "send_media": {
        if (!state?.channel?.sendMedia) return { content: "当前渠道不支持发送多媒体", is_error: true };
        const filePath = String(input.filePath ?? "");
        const mediaType = String(input.mediaType ?? "") as "image" | "file" | "video" | "voice";
        const filename = input.filename ? String(input.filename) : undefined;
        const result = await state.channel.sendMedia(filePath, mediaType, filename);
        if (!result.ok) return { content: `发送失败：${result.error}`, is_error: true };
        return { content: `${mediaType} 已发送` };
      }

      case "system_list_models": {
        const providerId = input.providerId ? String(input.providerId) : undefined;
        const provider = providerId
          ? agentConfig.current.providers?.find(p => p.id === providerId)
          : agentConfig.current;
        if (!provider) return { content: `未找到 provider: ${providerId}`, is_error: true };
        const models = await fetchModels({ type: (provider as any).type, apiKey: (provider as any).apiKey, baseURL: (provider as any).baseURL });
        if (!models.length) return { content: "未能获取模型列表，请检查 API Key 和网络" };
        return { content: `共 ${models.length} 个模型：\n${models.join("\n")}` };
      }

      case "system_set_model": {
        const model = String(input.model ?? "");
        const providerId = input.providerId ? String(input.providerId) : undefined;
        if (providerId) {
          const provider = agentConfig.current.providers?.find(p => p.id === providerId);
          if (!provider) return { content: `未找到 provider: ${providerId}`, is_error: true };
          applyConfig({ ...agentConfig.current, model, activeProviderId: providerId });
        } else {
          applyConfig({ ...agentConfig.current, model });
        }
        logger.info("model_switched", { model, providerId });
        return { content: `模型已切换为：${agentConfig.provider.model}（${agentConfig.current.type}）` };
      }

      case "system_list_providers": {
        const providers = agentConfig.current.providers ?? [];
        const activeId = agentConfig.current.activeProviderId;
        const lines = providers.map(p =>
          `${p.id === activeId ? "▶ " : "  "}${p.name} [${p.type}]${p.baseURL ? ` — ${p.baseURL}` : ""}`
        );
        return { content: `当前模型：${agentConfig.provider.model}\n\nProviders：\n${lines.join("\n")}` };
      }

      case "system_mcp_add": {
        const serverName = String(input.name ?? "");
        const config = {
          type: input.type as "streamable-http" | "sse" | "stdio",
          url: input.url ? String(input.url) : undefined,
          command: input.command ? String(input.command) : undefined,
          args: Array.isArray(input.args) ? input.args as string[] : undefined,
        };
        await addMcpServer(serverName, config);
        invalidateSystemPrompt();
        logger.info("mcp_added", { serverName });
        return { content: `MCP server "${serverName}" 已添加并连接` };
      }

      case "system_mcp_remove": {
        const serverName = String(input.name ?? "");
        await removeMcpServer(serverName);
        invalidateSystemPrompt();
        logger.info("mcp_removed", { serverName });
        return { content: `MCP server "${serverName}" 已移除` };
      }

      case "system_mcp_list": {
        const status = getMcpStatus();
        if (!status.length) return { content: "暂无 MCP server" };
        const lines = status.map(s =>
          `${s.connected ? "🟢" : "🔴"} ${s.name} — ${s.toolCount} 个工具`
        );
        return { content: lines.join("\n") };
      }

      case "cron_list": {
        const jobs = listCrons();
        if (!jobs.length) return { content: "暂无定时任务" };
        const lines = jobs.map(j => {
          const next = j.next_run > 0 ? new Date(j.next_run).toLocaleString() : "—";
          const last = j.last_run ? new Date(j.last_run).toLocaleString() : "从未";
          return `${j.enabled ? "✅" : "⏸"} [${j.id.slice(0, 8)}] ${j.name}\n  cron: ${j.cron} | 下次: ${next} | 上次: ${last}\n  任务: ${j.task.slice(0, 80)}`;
        });
        return { content: lines.join("\n\n") };
      }

      case "cron_add": {
        const job = addCron({
          name: String(input.name ?? ""),
          cron: String(input.cron ?? ""),
          task: String(input.task ?? ""),
          channel: state?.channelId,
          enabled: true,
        });
        const channelNote = job.channel ? `\n推送渠道：${job.channel}` : "";
        return { content: `定时任务已创建：${job.name}\ncron: ${job.cron}\n下次执行：${new Date(job.next_run).toLocaleString()}${channelNote}` };
      }

      case "cron_delete": {
        const idOrName = String(input.id ?? "");
        const jobs = listCrons();
        const job = jobs.find(j => j.id.startsWith(idOrName) || j.name === idOrName);
        if (!job) return { content: `未找到任务：${idOrName}`, is_error: true };
        deleteCron(job.id);
        return { content: `已删除定时任务：${job.name}` };
      }

      case "cron_toggle": {
        const idOrName = String(input.id ?? "");
        const enabled = Boolean(input.enabled);
        const jobs = listCrons();
        const job = jobs.find(j => j.id.startsWith(idOrName) || j.name === idOrName);
        if (!job) return { content: `未找到任务：${idOrName}`, is_error: true };
        updateCron(job.id, { enabled });
        return { content: `定时任务 "${job.name}" 已${enabled ? "启用" : "暂停"}` };
      }

      case "hook_list": {
        if (!existsSync(HOOKS_PATH)) return { content: "暂无 hooks 配置（~/.agent/hooks.json 不存在）" };
        const cfg = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
        const entries = Object.entries(cfg);
        if (!entries.length) return { content: "hooks.json 为空" };
        const lines = entries.map(([event, h]: [string, any]) =>
          `${event}: ${h.command}${h.timeout_ms ? ` (timeout: ${h.timeout_ms}ms)` : ""}`
        );
        return { content: lines.join("\n") };
      }

      case "hook_set": {
        const event = String(input.event ?? "");
        const command = String(input.command ?? "");
        const timeout_ms = input.timeout_ms ? Number(input.timeout_ms) : undefined;
        mkdirSync(path.dirname(HOOKS_PATH), { recursive: true });
        const cfg = existsSync(HOOKS_PATH) ? JSON.parse(readFileSync(HOOKS_PATH, "utf8")) : {};
        cfg[event] = timeout_ms ? { command, timeout_ms } : { command };
        writeFileSync(HOOKS_PATH, JSON.stringify(cfg, null, 2), "utf8");
        reloadHooks();
        return { content: `Hook 已设置：${event} → ${command}` };
      }

      case "hook_delete": {
        const event = String(input.event ?? "");
        if (!existsSync(HOOKS_PATH)) return { content: "hooks.json 不存在" };
        const cfg = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
        if (!(event in cfg)) return { content: `Hook 不存在：${event}`, is_error: true };
        delete cfg[event];
        writeFileSync(HOOKS_PATH, JSON.stringify(cfg, null, 2), "utf8");
        reloadHooks();
        return { content: `Hook 已删除：${event}` };
      }

      case "task_create": {
        const taskName = String(input.name ?? "");
        const subAgents = input.sub_agents as Array<{ agent: string; task: string }> ?? [];
        const isolation = (input.isolation as "none" | "worktree") ?? "none";
        if (!taskName || subAgents.length === 0) return { content: "name 和 sub_agents 不能为空", is_error: true };
        const sessionId = state?.id ?? "unknown";
        const task = createTask(sessionId, taskName, { isolation, cwd: state?.cwd });
        for (const sa of subAgents) {
          addSubAgent(task.id, sa.agent, sa.task);
        }
        // Fire async execution — don't await
        runTaskInBackground(task.id, state).catch(err => {
          logger.error("task_background_failed", err, { taskId: task.id });
        });
        return { content: `后台任务已创建：${task.name}\nID: ${task.id}\n子 agent: ${subAgents.length} 个\n状态: running` };
      }

      case "task_status": {
        const taskId = input.task_id ? String(input.task_id) : undefined;
        if (taskId) {
          const task = getTask(taskId);
          if (!task) return { content: `任务不存在：${taskId}`, is_error: true };
          const lines = [
            `任务: ${task.name} [${task.status}]`,
            ...task.subAgents.map(r => `  ${r.agentName}: ${r.status}${r.result ? ` — ${r.result.slice(0, 100)}` : ""}`),
          ];
          if (task.result) lines.push(`\n结果:\n${task.result.slice(0, 500)}`);
          return { content: lines.join("\n") };
        }
        const sessionId = state?.id ?? "unknown";
        const all = getSessionTasks(sessionId);
        if (all.length === 0) return { content: "当前没有后台任务" };
        const lines = all.map(t => `[${t.status}] ${t.name} (${t.id.slice(0, 12)}) — ${t.subAgents.length} 个子 agent`);
        return { content: lines.join("\n") };
      }

      case "task_cancel": {
        const taskId = String(input.task_id ?? "");
        const ok = cancelTask(taskId);
        return ok ? { content: `任务已取消：${taskId}` } : { content: `无法取消：${taskId}（可能已完成或不存在）`, is_error: true };
      }

      default:
        return { content: `Unknown system tool: ${name}`, is_error: true };
    }
  } catch (error) {
    logger.error("system_tool_exception", error, { toolName: name });
    return { content: error instanceof Error ? error.message : String(error), is_error: true };
  }
}

// ── Async task runner ─────────────────────────────────────────────────────────

async function runTaskInBackground(taskId: string, parentState?: SessionState): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;

  const { runAgent } = await import("../domain/agent.js");
  const { createSession } = await import("../infra/session.js");
  const { getAgentTemplate } = await import("../agents/index.js");
  const { createWorktree, removeWorktree } = await import("../infra/worktree.js");

  // Create worktree if isolation requested
  let worktreeCwd: string | null = null;
  if (task.isolation === "worktree" && parentState?.cwd) {
    worktreeCwd = createWorktree(parentState.cwd, task.id);
    if (worktreeCwd) task.cwd = worktreeCwd;
  }

  const promises = task.subAgents.map(async (run) => {
    const template = getAgentTemplate(run.agentName);
    if (!template) {
      failSubAgent(taskId, run.id, `Unknown agent: ${run.agentName}`);
      return;
    }

    startSubAgent(taskId, run.id);
    const childState = createSession();
    childState.messages.push({ role: "user", content: run.prompt });
    // Use worktree cwd if available, otherwise parent cwd
    if (task.cwd) childState.cwd = task.cwd;
    else if (parentState?.cwd) childState.cwd = parentState.cwd;

    const parts: string[] = [];
    try {
      await runAgent(childState, {
        provider: agentConfig.provider,
        systemPrompt: template.systemPrompt,
        onEvent: (event: any) => { if (event.type === "text") parts.push(event.delta); },
        maxIterations: template.maxIterations ?? 20,
        allowedTools: template.tools,
      });
      completeSubAgent(taskId, run.id, parts.join("").trim() || "子 agent 未返回结果");
    } catch (error) {
      failSubAgent(taskId, run.id, error instanceof Error ? error.message : String(error));
    }
  });

  await Promise.all(promises);

  // Clean up worktree after task completes
  if (worktreeCwd && parentState?.cwd) {
    removeWorktree(parentState.cwd, task.id);
  }

  // Push result to channel if available
  const completedTask = getTask(taskId);
  if (completedTask?.result && parentState?.channelId) {
    try {
      const { sendToWecomChannel } = await import("../adapters/wecom.js");
      await sendToWecomChannel(parentState.channelId, `[后台任务完成：${completedTask.name}]\n\n${completedTask.result.slice(0, 2000)}`);
    } catch (error) {
      logger.error("task_push_failed", error, { taskId });
    }
  }
}
