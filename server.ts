import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { initMcp, mcpConnections, startMcpHealthCheck } from "./infra/mcp.js";
import { agentConfig } from "./infra/config.js";
import { handleWebSocket } from "./adapters/websocket.js";
import { initWecom, disconnectWecom, sendToWecomChannel } from "./adapters/wecom.js";
import { getSystemPrompt, invalidateSystemPrompt } from "./prompt.js";
import { handleApiRequest } from "./routes/api.js";
import { handlePageRequest } from "./routes/pages.js";
import { createLogger } from "./infra/logger.js";
import { loadHooks } from "./infra/hooks.js";
import { startScheduler } from "./infra/cron.js";
import { formatTokenUsage } from "./infra/usage.js";
import { ensureUsableDnsServers } from "./infra/dns-fix.js";
import type { CronJob } from "./infra/cron.js";

const logger = createLogger("server");

// Must run before any network call (MCP/provider/wecom): if the Node runtime came up with
// a broken loopback DNS server, repoint it at the real resolvers from /etc/resolv.conf.
ensureUsableDnsServers();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

loadEnv(path.join(__dirname, ".env"));
loadEnv(path.join(process.cwd(), ".env"));

const agentOpts = {
  get provider() { return agentConfig.provider; },
  get systemPrompt() { return getSystemPrompt(); },
};

const httpServer = createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: agentConfig.provider.model }));
    return;
  }

  if (url === "/health/ready") {
    const { getActiveSessions } = await import("./infra/session.js");
    const running = getActiveSessions().filter(s => s.running);
    const ready = running.length === 0;
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ready, running: running.length, sessions: running.map(s => ({ id: s.sessionId, channel: s.channel })) }));
    return;
  }

  if (await handleApiRequest(req, res, url, agentOpts)) return;
  if (handlePageRequest(req, res, url)) return;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(path.join(__dirname, "app.html")));
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws, req) => {
  handleWebSocket(ws, req.url ?? "/", agentOpts);
});

initMcp().then(() => {
  loadHooks();
  startScheduler(runCronJob);
  startMcpHealthCheck();
  invalidateSystemPrompt();
  initWecom(agentOpts);
  httpServer.listen(PORT, () => logger.info("listening", { url: `http://localhost:${PORT}`, port: PORT }));
}).catch((error) => {
  logger.error("startup_failed", error);
  process.exitCode = 1;
});

httpServer.on("error", (error) => {
  logger.error("http_server_error", error, { port: PORT });
});

wss.on("error", (error) => {
  logger.error("websocket_server_error", error);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", error);
  process.exitCode = 1;
});

process.on("SIGTERM", async () => {
  disconnectWecom();
  for (const conn of mcpConnections) {
    await conn.client.close().catch((error) => {
      logger.error("mcp_close_failed", error, { serverName: conn.serverName });
    });
  }
  process.exit(0);
});

const CRON_JOB_TIMEOUT_MS = Number(process.env.CRON_JOB_TIMEOUT_MS ?? 30 * 60 * 1000); // 30 min

async function runCronJob(job: CronJob): Promise<void> {
  const { createSession } = await import("./infra/session.js");
  const { runAgent } = await import("./domain/agent.js");
  const state = createSession();
  state.messages.push({ role: "user", content: job.task });
  const parts: string[] = [];
  let finalUsage: import("./infra/provider.js").TokenUsage | undefined;

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Cron job timeout after ${CRON_JOB_TIMEOUT_MS}ms`)), CRON_JOB_TIMEOUT_MS)
  );

  await Promise.race([
    runAgent(state, {
      ...agentOpts,
      onEvent: (e) => {
        if (e.type === "text") parts.push(e.delta);
        else if (e.type === "done") finalUsage = e.usage;
      },
    }),
    timeout,
  ]);

  const result = parts.join("") || "完成。";
  logger.info("cron_done", { id: job.id, name: job.name, resultLength: result.length });

  if (job.channel) {
    try {
      const usageNote = finalUsage ? `\n\n---\n${formatTokenUsage(finalUsage)}` : "";
      await sendToWecomChannel(job.channel, `[定时任务：${job.name}]\n\n${result}${usageNote}`);
      logger.info("cron_channel_sent", { id: job.id, channel: job.channel });
    } catch (error) {
      logger.error("cron_channel_send_failed", error, { id: job.id, channel: job.channel });
    }
  }
}

function loadEnv(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!key || rest.length === 0) continue;
    process.env[key] = rest.join("=").trim();
  }
}

export function reloadEnv() {
  loadEnv(path.join(__dirname, ".env"));
  loadEnv(path.join(process.cwd(), ".env"));
}
