import type { SessionState, AgentOptions } from "./domain/types.js";
import { estimateTokens, prepareMessages } from "./domain/context.js";
import { agentConfig, getConfigForClient, applyConfig } from "./infra/config.js";
import { getActiveMemories, getMemoriesByType, searchMemories } from "./memory/index.js";
import { getTraces } from "./infra/trace.js";
import { rewriteSessionMessages } from "./infra/session.js";
import { agentTemplates } from "./agents/index.js";
import { listCrons, addCron, deleteCron, updateCron } from "./infra/cron.js";

type CommandHandler = (args: string, state: SessionState, opts: Omit<AgentOptions, "onEvent">) => Promise<string> | string;

const commands: Record<string, { description: string; handler: CommandHandler }> = {
  help: {
    description: "显示可用命令",
    handler: () => {
      return Object.entries(commands)
        .map(([name, { description }]) => `/${name} — ${description}`)
        .join("\n");
    },
  },

  context: {
    description: "查看当前 context 使用情况",
    handler: (_, state) => {
      const estimated = state.messages.reduce((s, m) => s + estimateTokens(m), 0);
      const actual = state.lastInputTokens;
      const contextWindow = agentConfig.provider.contextWindow;
      const total = actual ?? estimated;
      const pct = ((total / contextWindow) * 100).toFixed(1);
      const tokenLabel = actual
        ? `实际 tokens：${total.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct}%)`
        : `估算 tokens：${total.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct}%)（尚无实际数据）`;
      const providerType = agentConfig.provider.type;
      const tier1 = providerType === "anthropic" ? 70 : 50;
      const tier2 = providerType === "anthropic" ? 85 : 70;
      return `Context 使用情况：
- 消息数：${state.messages.length}
- ${tokenLabel}
- 模型：${agentConfig.provider.model}
- 压缩阈值：tier1=${(contextWindow * tier1 / 100).toLocaleString()} (${tier1}%)  tier2=${(contextWindow * tier2 / 100).toLocaleString()} (${tier2}%)`;
    },
  },

  compact: {
    description: "主动压缩对话历史",
    handler: async (_, state) => {
      const before = state.messages.reduce((s, m) => s + estimateTokens(m), 0);
      // Force compression by passing a high token count to bypass the threshold check
      const { messages: compressed } = await prepareMessages(state.messages, state.lastInputTokens ?? before * 4);
      const after = compressed.reduce((s: number, m: any) => s + estimateTokens(m), 0);
      state.messages.splice(0, state.messages.length, ...compressed);
      // Persist the compressed history so it survives reconnect/DB reload and isn't
      // recomputed next turn (same in-memory-only pitfall as /clear had).
      rewriteSessionMessages(state.id, state.messages);
      state.lastInputTokens = undefined;
      return `压缩完成：${before.toLocaleString()} → ${after.toLocaleString()} tokens（节省 ${((1 - after / before) * 100).toFixed(0)}%）`;
    },
  },

  clear: {
    description: "清空对话历史（保留记忆）",
    handler: (_, state) => {
      state.messages.splice(0, state.messages.length);
      // Persist the clear: in-memory state is reused across turns AND reloaded from DB on
      // reconnect, so wiping only state.messages let history resurrect from sqlite.
      rewriteSessionMessages(state.id, []);
      state.lastInputTokens = undefined;
      state.lastActivityAt = undefined;
      return "对话历史已清空。记忆和配置保留。";
    },
  },

  model: {
    description: "查看或切换模型（/model 或 /model <name>）",
    handler: (args) => {
      if (!args) return `当前模型：${agentConfig.provider.model}\n切换：/model <model-name>`;
      applyConfig({ ...agentConfig.current, model: args });
      return `模型已切换为：${agentConfig.provider.model}`;
    },
  },

  memory: {
    description: "查看记忆概况",
    handler: () => {
      const all = getActiveMemories();
      const byType: Record<string, number> = {};
      for (const m of all) byType[m.type] = (byType[m.type] ?? 0) + 1;
      const lines = [`记忆总数：${all.length}`];
      for (const [type, count] of Object.entries(byType)) lines.push(`  ${type}: ${count}`);
      const core = getMemoriesByType("user_profile").filter(m => m.source === "user_explicit");
      if (core.length > 0) {
        lines.push(`\n核心记忆（注入 system）：`);
        for (const m of core.slice(0, 10)) lines.push(`  - ${m.content}`);
      }
      return lines.join("\n");
    },
  },

  skills: {
    description: "查看或搜索已保存的技能（/skills 或 /skills <关键词>）",
    handler: (args) => {
      const skills = args
        ? searchMemories(args, 20).filter(m => m.type === "skill")
        : getMemoriesByType("skill");
      if (skills.length === 0) return args ? `没有找到匹配技能：${args}` : "还没有保存 skill。";
      return [
        `技能数：${skills.length}`,
        ...skills.slice(0, 20).map(m => `- ${m.content}${m.tags.length ? ` [${m.tags.join(", ")}]` : ""}`),
      ].join("\n");
    },
  },

  config: {
    description: "查看当前配置",
    handler: () => {
      const cfg = getConfigForClient();
      return `Provider: ${cfg.type}\nModel: ${cfg.model}\nBase URL: ${cfg.baseURL ?? "(default)"}\nAPI Key: ${cfg.apiKey ? "***" + cfg.apiKey.slice(-4) : "(not set)"}`;
    },
  },

  status: {
    description: "查看 session 状态",
    handler: (_, state) => {
      const traces = getTraces(state.id);
      return `Session: ${state.id}\nCWD: ${state.cwd}\n消息数: ${state.messages.length}\n执行记录: ${traces.length}`;
    },
  },

  cost: {
    description: "查看本 session 的 token 消耗",
    handler: (_, state) => {
      const traces = getTraces(state.id);
      // Sum up from trace data would require loading full traces; show count for now
      return `本 session 共 ${traces.length} 次执行。\n详细 token 消耗请查看追踪页面。`;
    },
  },

  agent: {
    description: "管理子 agent 模板（/agent list | /agent new | /agent del <name>）",
    handler: (args) => {
      const [sub, ...rest] = args.split(/\s+/);

      if (!sub || sub === "list") {
        if (!agentTemplates.length) return "暂无子 agent 模板。使用 /agent new 创建。";
        return agentTemplates.map(t =>
          `• ${t.name}：${t.description}\n  工具：${t.tools?.join(", ") ?? "全部"} · 最大迭代：${t.maxIterations ?? 20}`
        ).join("\n\n");
      }

      if (sub === "new") {
        return `请按以下格式告诉我要创建的子 agent 信息，我来帮你创建：

名称：（英文下划线，如 code_agent）
描述：（主 agent 用来判断何时调用，一句话）
System Prompt：（子 agent 的角色和规则）
允许的工具：（逗号分隔，留空=全部，可选：bash, read_file, write_file, edit_file, glob, grep, web_search, web_fetch, browser_*, memory_*）
最大迭代次数：（默认 20）

填好后直接发给我，我会调用工具创建。`;
      }

      if (sub === "del") {
        const name = rest.join(" ").trim();
        if (!name) return "用法：/agent del <name>";
        const exists = agentTemplates.find(t => t.name === name);
        if (!exists) return `未找到模板：${name}\n当前模板：${agentTemplates.map(t => t.name).join(", ") || "（无）"}`;
        return `确认删除子 agent 模板 "${name}"？请回复"确认删除 ${name}"。`;
      }

      return `/agent list — 列出所有模板\n/agent new — 创建新模板\n/agent del <name> — 删除模板`;
    },
  },

  cron: {
    description: "管理定时任务",
    handler: async (args, state) => {
      const [sub, ...rest] = args.trim().split(/\s+/);

      if (!sub || sub === "list") {
        const jobs = listCrons();
        if (jobs.length === 0) return "暂无定时任务。";
        return jobs.map(j => {
          const next = j.next_run > 0 ? new Date(j.next_run).toLocaleString() : "—";
          const last = j.last_run ? new Date(j.last_run).toLocaleString() : "从未";
          const status = j.enabled ? "✅" : "⏸";
          return `${status} [${j.id.slice(0, 8)}] ${j.name}\n   cron: ${j.cron}\n   任务: ${j.task.slice(0, 60)}${j.task.length > 60 ? "..." : ""}\n   下次: ${next}  上次: ${last}`;
        }).join("\n\n");
      }

      if (sub === "add") {
        // /cron add <cron_expr> <name> -- <task>
        // e.g. /cron add "0 9 * * *" 早报 -- 搜索今日科技新闻并总结
        const raw = rest.join(" ");
        const match = raw.match(/^"([^"]+)"\s+(.+?)\s+--\s+(.+)$/) || raw.match(/^(\S+)\s+(.+?)\s+--\s+(.+)$/);
        if (!match) return '用法：/cron add "<cron>" <名称> -- <任务描述>\n例：/cron add "0 9 * * *" 早报 -- 搜索今日科技新闻并总结';
        const [, cron, name, task] = match;
        try {
          const job = addCron({ name, cron, task, channel: state.channelId, enabled: true });
          const channelNote = job.channel ? `\n推送渠道：${job.channel}` : "";
          return `✅ 定时任务已创建：${job.name}\ncron: ${job.cron}\n下次执行：${new Date(job.next_run).toLocaleString()}${channelNote}`;
        } catch (e) {
          return `❌ 创建失败：${e instanceof Error ? e.message : String(e)}`;
        }
      }

      if (sub === "del" || sub === "delete") {
        const id = rest[0];
        if (!id) return "用法：/cron del <id>";
        const jobs = listCrons();
        const job = jobs.find(j => j.id.startsWith(id) || j.name === id);
        if (!job) return `未找到任务：${id}`;
        deleteCron(job.id);
        return `✅ 已删除：${job.name}`;
      }

      if (sub === "enable" || sub === "disable") {
        const id = rest[0];
        if (!id) return `用法：/cron ${sub} <id>`;
        const jobs = listCrons();
        const job = jobs.find(j => j.id.startsWith(id) || j.name === id);
        if (!job) return `未找到任务：${id}`;
        updateCron(job.id, { enabled: sub === "enable" });
        return `✅ 已${sub === "enable" ? "启用" : "暂停"}：${job.name}`;
      }

      return "/cron list — 列出所有任务\n/cron add \"<cron>\" <名称> -- <任务> — 新建任务\n/cron del <id|名称> — 删除任务\n/cron enable/disable <id|名称> — 启用/暂停";
    },
  },

  workflow: {
    description: "workflow 功能已下线",
    handler: () => "workflow 相关功能已下线：自动触发、命令入口和 API 均已关闭。历史数据未删除。",
  },
};


export async function handleSlashCommand(
  input: string,
  state: SessionState,
  opts: Omit<AgentOptions, "onEvent">
): Promise<string | null> {
  const match = input.match(/^\/(\w+)\s*(.*)?$/);
  if (!match) return null;

  const [, name, args] = match;
  const cmd = commands[name];
  if (!cmd) return `未知命令: /${name}\n输入 /help 查看可用命令`;

  return await cmd.handler(args?.trim() ?? "", state, opts);
}
