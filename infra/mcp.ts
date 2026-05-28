import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, truncateValue } from "./logger.js";

const logger = createLogger("mcp");

type McpConnection = { client: Client; serverName: string; tools: Anthropic.Tool[] };

export const mcpConnections: McpConnection[] = [];
export const mcpToolMap = new Map<string, McpConnection>();

const MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp.json");

export type McpServerConfig = {
  type?: "streamable-http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export function getMcpConfig(): Record<string, McpServerConfig> {
  const paths = [path.join(os.homedir(), ".mcp.json"), MCP_CONFIG_PATH];
  const merged: Record<string, McpServerConfig> = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (data.mcpServers) Object.assign(merged, data.mcpServers);
    } catch (error) {
      logger.warn("config_parse_failed", { path: p, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return merged;
}

export function saveMcpConfig(servers: Record<string, McpServerConfig>) {
  mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
}

export function getMcpStatus(): Array<{ name: string; connected: boolean; toolCount: number; config: McpServerConfig }> {
  const config = getMcpConfig();
  return Object.entries(config).map(([name, cfg]) => {
    const conn = mcpConnections.find(c => c.serverName === name);
    return { name, connected: !!conn, toolCount: conn?.tools.length ?? 0, config: cfg };
  });
}

export async function addMcpServer(name: string, config: McpServerConfig) {
  const current = getMcpConfig();
  current[name] = config;
  saveMcpConfig(current);
  try {
    await connectMcpServer(name, config);
  } catch (error) {
    logger.error("connect_failed", error, { serverName: name });
    throw error;
  }
}

export async function removeMcpServer(name: string) {
  const idx = mcpConnections.findIndex(c => c.serverName === name);
  if (idx >= 0) {
    const conn = mcpConnections[idx];
    for (const t of conn.tools) mcpToolMap.delete(t.name);
    await conn.client.close().catch((error) => {
      logger.error("close_failed", error, { serverName: conn.serverName, operation: "remove" });
    });
    mcpConnections.splice(idx, 1);
  }
  const current = getMcpConfig();
  delete current[name];
  saveMcpConfig(current);
}

const MCP_HEALTH_INTERVAL_MS = Number(process.env.MCP_HEALTH_INTERVAL_MS ?? 60_000); // 1 min
let healthTimer: ReturnType<typeof setInterval> | undefined;

export function startMcpHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    const config = getMcpConfig();
    for (const [name, cfg] of Object.entries(config)) {
      const conn = mcpConnections.find(c => c.serverName === name);
      if (!conn) {
        logger.warn("mcp_disconnected_reconnecting", { serverName: name });
        try {
          await connectMcpServer(name, cfg);
          logger.info("mcp_reconnected", { serverName: name });
        } catch (error) {
          logger.error("mcp_reconnect_failed", error, { serverName: name });
        }
      }
    }
  }, MCP_HEALTH_INTERVAL_MS);
}

export function stopMcpHealthCheck() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
}

export async function reconnectAll() {
  for (const conn of mcpConnections) {
    for (const t of conn.tools) mcpToolMap.delete(t.name);
    await conn.client.close().catch((error) => {
      logger.error("close_failed", error, { serverName: conn.serverName, operation: "reconnect_all" });
    });
  }
  mcpConnections.length = 0;
  await initMcp();
}

export async function initMcp() {
  const mcpPaths = [path.join(os.homedir(), ".mcp.json"), path.join(process.cwd(), ".mcp.json")];
  const seen = new Set<string>();

  for (const mcpPath of mcpPaths) {
    if (!existsSync(mcpPath)) continue;
    let config: { mcpServers?: Record<string, any> };
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch (error) {
      logger.warn("config_parse_failed", { path: mcpPath, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!config.mcpServers) continue;

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        await connectMcpServer(name, serverConfig);
      } catch (error) {
        logger.error("init_connect_failed", error, { serverName: name });
      }
    }
  }
  logger.info("init_complete", { serverCount: mcpConnections.length, toolCount: mcpToolMap.size });
}

async function connectMcpServer(name: string, config: any) {
  const client = new Client({ name: "agent", version: "1.0.0" });
  let transport;

  if (config.type === "streamable-http" || config.type === "sse") {
    transport = new StreamableHTTPClientTransport(new URL(config.url));
  } else {
    transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...process.env, ...config.env } });
  }

  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();
  const converted: Anthropic.Tool[] = mcpTools.map((t) => ({
    name: `mcp_${name}_${t.name}`,
    description: `[MCP:${name}] ${t.description ?? t.name}`,
    input_schema: (t.inputSchema as Anthropic.Tool["input_schema"]) ?? { type: "object", properties: {} },
  }));

  const conn: McpConnection = { client, serverName: name, tools: converted };
  mcpConnections.push(conn);
  for (const t of converted) mcpToolMap.set(t.name, conn);
  logger.info("connected", { serverName: name, toolCount: converted.length });
}

export async function callMcpTool(toolName: string, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }> {
  const conn = mcpToolMap.get(toolName);
  if (!conn) return { content: `Unknown MCP tool: ${toolName}`, is_error: true };
  const originalName = toolName.replace(`mcp_${conn.serverName}_`, "");
  try {
    const result = await conn.client.callTool({ name: originalName, arguments: input });
    const text = Array.isArray(result.content)
      ? result.content.map((b: any) => b.type === "text" ? b.text : JSON.stringify(b)).join("\n")
      : String(result.content);
    const limit = Number(process.env.TOOL_OUTPUT_LIMIT ?? 60000);
    return { content: text.length <= limit ? text : text.slice(0, limit) + `\n... truncated`, is_error: result.isError === true };
  } catch (error) {
    logger.error("tool_call_failed", error, {
      serverName: conn.serverName,
      toolName,
      originalName,
      input: truncateValue(input, 2000),
    });
    const message = error instanceof Error ? error.message : String(error);
    return { content: `MCP tool ${toolName} failed: ${message}`, is_error: true };
  }
}

export function getMcpTools(): Anthropic.Tool[] {
  return mcpConnections.flatMap((c) => c.tools);
}
