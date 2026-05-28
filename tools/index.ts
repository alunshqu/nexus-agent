import type Anthropic from "@anthropic-ai/sdk";
import type { SessionState } from "../domain/types.js";
import { truncateToolOutput } from "../domain/context.js";
import { asRecord, formatError } from "./helpers.js";
import { bashTool, setCwdTool, toolBash, toolSetCwd } from "./shell.js";
import { filesystemTools, toolReadFile, toolWriteFile, toolEditFile, toolListDir, toolGlob, toolGrep } from "./filesystem.js";
import { webTools, toolWebFetch, toolWebSearch } from "./web.js";
import { getAgentToolSchema, getAgentsParallelToolSchema, getAgentManageToolSchemas, executeAgentTool, executeAgentsParallelTool, executeAgentManageTool } from "./agent.js";
import { systemTools, executeSystemTool } from "./system.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("tool_dispatch");

export const tools: Anthropic.Tool[] = [bashTool, setCwdTool, ...filesystemTools, ...webTools, getAgentToolSchema(), getAgentsParallelToolSchema(), ...getAgentManageToolSchemas(), ...systemTools];

export async function executeTool(
  state: SessionState,
  name: string,
  rawInput: unknown
): Promise<{ content: string; is_error?: boolean }> {
  const input = asRecord(rawInput);
  try {
    let content: string;
    switch (name) {
      case "bash": content = await toolBash(state, input); break;
      case "set_cwd": content = toolSetCwd(state, input); break;
      case "read_file": content = await toolReadFile(state, input); break;
      case "write_file": content = await toolWriteFile(state, input); break;
      case "edit_file": content = await toolEditFile(state, input); break;
      case "list_dir": content = await toolListDir(state, input); break;
      case "glob": content = await toolGlob(state, input); break;
      case "grep": content = await toolGrep(state, input); break;
      case "web_fetch": content = await toolWebFetch(input); break;
      case "web_search": content = await toolWebSearch(input); break;
      case "agent_run": {
        const r = await executeAgentTool(state, input);
        return { ...r, content: truncateToolOutput(r.content) };
      }
      case "agents_run_parallel": {
        const r = await executeAgentsParallelTool(state, input);
        return { ...r, content: truncateToolOutput(r.content) };
      }
      case "agent_create":
      case "agent_delete":
      case "agent_list": return await executeAgentManageTool(state, name, input);
      case "send_media":
      case "system_set_model":
      case "system_list_providers":
      case "system_list_models":
      case "system_mcp_add":
      case "system_mcp_remove":
      case "system_mcp_list":
      case "cron_list":
      case "cron_add":
      case "cron_delete":
      case "cron_toggle":
      case "hook_list":
      case "hook_set":
      case "hook_delete":
      case "task_create":
      case "task_status":
      case "task_cancel": return await executeSystemTool(name, input, state);
      default:
        logger.warn("unknown_tool", { toolName: name });
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
    return { content: truncateToolOutput(content) };
  } catch (error) {
    return { content: formatError(error), is_error: true };
  }
}
