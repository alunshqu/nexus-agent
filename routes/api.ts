import type { IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { agentConfig, applyConfig, cacheProviderModels, getConfigForClient, resetConfig, upsertProvider } from "../infra/config.js";import { fetchModels } from "../infra/provider.js";
import { getTraces, getTrace, getAllTraces, getRecentFullTraces } from "../infra/trace.js";
import { getMcpStatus, addMcpServer, removeMcpServer, reconnectAll } from "../infra/mcp.js";
import { handleHttpChat, handleSessionGet } from "../adapters/http.js";
import { invalidateSystemPrompt } from "../prompt.js";
import { agentTemplates, upsertAgentTemplate, deleteAgentTemplate } from "../agents/index.js";
import { getActiveSessions, onSessionStatusChange } from "../infra/session.js";
import type { AgentOptions } from "../domain/types.js";
import { createLogger, redact } from "../infra/logger.js";
import { listCrons, getCron, addCron, updateCron, deleteCron } from "../infra/cron.js";
import { reloadHooks } from "../infra/hooks.js";
import { getMetrics, gauge } from "../infra/metrics.js";
import { summarizeCacheUsage } from "../infra/cache-usage.js";
import { buildAgentTeamWorkflow, type AgentTeamKind } from "../workflows/agent-team.js";
import { createWorkflowStore } from "../workflows/store.js";
import { runWorkflow } from "../workflows/runtime.js";

const logger = createLogger("api");

const SKILLS_DIR = path.join(os.homedir(), ".agent", "skills");

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  agentOpts: Omit<AgentOptions, "onEvent">
): Promise<boolean> {
  if (url.startsWith("/api/sessions/") && url.endsWith("/reset") && req.method === "POST") {
    const sessionId = url.split("/")[3];
    const { updateSessionStatus, resetInMemorySessionRunning } = await import("../infra/session.js");
    updateSessionStatus(sessionId, { running: false, currentTool: undefined, currentPhase: undefined });
    resetInMemorySessionRunning(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionId }));
    return true;
  }

  if (url === "/api/sessions" && req.method === "GET") {
    const sessions = getActiveSessions();
    gauge("sessions.active", sessions.filter(s => s.running).length);
    gauge("sessions.total", sessions.length);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return true;
  }

  if (url === "/api/metrics" && req.method === "GET") {
    const sessions = getActiveSessions();
    gauge("sessions.active", sessions.filter(s => s.running).length);
    gauge("sessions.total", sessions.length);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getMetrics()));
    return true;
  }

  if (url.startsWith("/api/cache-usage") && req.method === "GET") {
    const parsed = new URL(url, "http://localhost");
    const limit = Math.min(Math.max(Number(parsed.searchParams.get("limit") ?? 50), 1), 500);
    const summary = summarizeCacheUsage(getRecentFullTraces(limit));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summary));
    return true;
  }

  if (url === "/api/sessions/stream" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const write = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    write(getActiveSessions());
    const unsub = onSessionStatusChange((statuses) => write(statuses));
    req.on("close", unsub);
    return true;
  }

  if (url === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getConfigForClient()));
    return true;
  }

  if (url === "/api/config" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const body = JSON.parse(bodyStr);
      logger.info("config_post", { body: redact(body) });
      if (body.reset) resetConfig();
      else applyConfig({ ...agentConfig.current, ...body });
      invalidateSystemPrompt();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, model: agentConfig.provider.model }));
    } catch (e) {
      logger.error("config_post_failed", e);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return true;
  }

  if (url === "/api/models" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    const cfg = JSON.parse(bodyStr || "{}");
    const provider = cfg.providerId
      ? agentConfig.current.providers?.find(p => p.id === cfg.providerId)
      : undefined;
    const fetchCfg = { ...(provider ?? {}), ...cfg };
    const models = await fetchModels(fetchCfg);
    if (cfg.providerId && models.length > 0) cacheProviderModels(cfg.providerId, models);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models, fetchedAt: Date.now() }));
    return true;
  }

  if (url === "/api/providers" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const body = JSON.parse(bodyStr || "{}");
      const provider = upsertProvider(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, provider, config: getConfigForClient() }));
    } catch (e) {
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(bodyStr || "{}"); } catch { parsedBody = "[invalid-json]"; }
      logger.error("provider_upsert_failed", e, { body: redact(parsedBody) });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return true;
  }

  if (url === "/api/traces" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getAllTraces()));
    return true;
  }

  if (url.startsWith("/api/traces/") && req.method === "GET") {
    const parts = url.split("/");
    const sessionId = parts[3];
    const traceId = parts[4];
    if (traceId) {
      const trace = getTrace(sessionId, traceId);
      if (!trace) { res.writeHead(404); res.end(); return true; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(trace));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getTraces(sessionId)));
    }
    return true;
  }

  if (url.startsWith("/api/chat") && req.method === "POST") {
    handleHttpChat(req, res, agentOpts);
    return true;
  }

  if (url.startsWith("/api/sessions/") && req.method === "GET") {
    handleSessionGet(req, res);
    return true;
  }

  // ── MCP management ──────────────────────────────────────────────────────────

  if (url === "/api/mcp" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getMcpStatus()));
    return true;
  }

  if (url === "/api/mcp" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const { name, config } = JSON.parse(bodyStr);
      if (!name || !config) throw new Error("name and config required");
      await addMcpServer(name, config);
      invalidateSystemPrompt();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: getMcpStatus() }));
    } catch (e) {
      logger.error("mcp_add_failed", e);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/mcp/search") && req.method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const q = params.get("q") ?? "";
    try {
      const r = await fetch(`https://api.smithery.ai/servers?q=${encodeURIComponent(q)}&pageSize=12`);
      const data = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      logger.error("smithery_servers_search_failed", e, { query: q });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Smithery API unavailable" }));
    }
    return true;
  }

  if (url.startsWith("/api/mcp/skills") && req.method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const q = params.get("q") ?? "";
    try {
      const r = await fetch(`https://api.smithery.ai/skills?q=${encodeURIComponent(q)}&pageSize=12`);
      const data = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      logger.error("smithery_skills_search_failed", e, { query: q });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Smithery API unavailable" }));
    }
    return true;
  }

  if (url.startsWith("/api/mcp/details/") && req.method === "GET") {
    const qualifiedName = decodeURIComponent(url.slice("/api/mcp/details/".length));
    try {
      const r = await fetch(`https://api.smithery.ai/servers/${encodeURIComponent(qualifiedName)}`);
      const data = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      logger.error("smithery_server_details_failed", e, { qualifiedName });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Smithery API unavailable" }));
    }
    return true;
  }

  if (url.startsWith("/api/mcp/") && req.method === "DELETE") {
    const name = decodeURIComponent(url.slice("/api/mcp/".length));
    try {
      await removeMcpServer(name);
      invalidateSystemPrompt();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: getMcpStatus() }));
    } catch (e) {
      logger.error("mcp_remove_failed", e, { name });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url === "/api/mcp/reconnect" && req.method === "POST") {
    try {
      await reconnectAll();
      invalidateSystemPrompt();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: getMcpStatus() }));
    } catch (e) {
      logger.error("mcp_reconnect_failed", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  // ── Agent templates ──────────────────────────────────────────────────────────

  if (url === "/api/tools" && req.method === "GET") {
    const { tools } = await import("../tools/index.js");
    const { browserTools } = await import("../tools/browser.js");
    const { memoryTools } = await import("../memory/tools.js");
    const { getMcpTools } = await import("../infra/mcp.js");
    const allNames = [
      ...tools.map(t => t.name),
      ...browserTools.map(t => t.name),
      ...memoryTools.map(t => t.name),
      ...getMcpTools().map(t => t.name),
    ].filter(n => n !== "agent_run" && n !== "agents_run_parallel");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(allNames));
    return true;
  }

  if (url === "/api/agents" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentTemplates));
    return true;
  }

  if (url === "/api/agents" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const template = JSON.parse(bodyStr);
      if (!template.name || !template.systemPrompt) throw new Error("name and systemPrompt required");
      upsertAgentTemplate(template);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, templates: agentTemplates }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/agents/") && req.method === "DELETE") {
    const name = decodeURIComponent(url.slice("/api/agents/".length));
    deleteAgentTemplate(name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, templates: agentTemplates }));
    return true;
  }

  // ── Skills (SKILL.md files in ~/.agent/skills/) ─────────────────────────────

  if (url === "/api/skills" && req.method === "GET") {
    mkdirSync(SKILLS_DIR, { recursive: true });
    const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const mdPath = path.join(SKILLS_DIR, d.name, "SKILL.md");
        if (!existsSync(mdPath)) return null;
        const content = readFileSync(mdPath, "utf8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const fm: Record<string, string> = {};
        if (fmMatch) fmMatch[1].split("\n").forEach(line => { const [k, ...v] = line.split(":"); if (k.trim()) fm[k.trim()] = v.join(":").trim(); });
        return { name: d.name, description: fm.description ?? "", displayName: fm.name ?? d.name };
      }).filter(Boolean);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(skills));
    return true;
  }

  if (url === "/api/skills" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const { name, gitUrl } = JSON.parse(bodyStr);
      if (!name || !gitUrl) throw new Error("name and gitUrl required");
      const rawUrl = gitUrlToRaw(gitUrl);
      const res2 = await fetch(rawUrl);
      if (!res2.ok) throw new Error(`Failed to fetch SKILL.md: ${res2.status}`);
      const content = await res2.text();
      const skillDir = path.join(SKILLS_DIR, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name }));
    } catch (e) {
      logger.error("skill_install_failed", e);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/skills/") && req.method === "DELETE") {
    const name = decodeURIComponent(url.slice("/api/skills/".length));
    const skillDir = path.join(SKILLS_DIR, name);
    if (existsSync(skillDir)) rmSync(skillDir, { recursive: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── Crons ────────────────────────────────────────────────────────────────────

  if (url === "/api/crons" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listCrons()));
    return true;
  }

  if (url === "/api/crons" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const body = JSON.parse(bodyStr);
      if (!body.name || !body.cron || !body.task) throw new Error("name, cron, task required");
      const job = addCron({ name: body.name, cron: body.cron, task: body.task, channel: body.channel, enabled: body.enabled ?? true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, job }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/crons/") && req.method === "PATCH") {
    const id = decodeURIComponent(url.slice("/api/crons/".length));
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const patch = JSON.parse(bodyStr);
      const job = updateCron(id, patch);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, job }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/crons/") && req.method === "DELETE") {
    const id = decodeURIComponent(url.slice("/api/crons/".length));
    const ok = deleteCron(id);
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
    return true;
  }

  // ── Workflows ─────────────────────────────────────────────────────────────────

  if (url === "/api/workflows" && req.method === "GET") {
    const store = createWorkflowStore();
    const parsed = new URL(url, "http://localhost");
    const limit = Math.min(Math.max(Number(parsed.searchParams.get("limit") ?? 50), 1), 500);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(store.listRuns(limit)));
    return true;
  }

  if (url === "/api/workflows" && req.method === "POST") {
    let bodyStr = "";
    for await (const chunk of req) bodyStr += chunk;
    try {
      const body = JSON.parse(bodyStr || "{}");
      const kind = body.kind as AgentTeamKind;
      if (kind !== "research" && kind !== "code" && kind !== "kb") throw new Error("kind must be research, code or kb");
      if (!body.objective || typeof body.objective !== "string") throw new Error("objective required");
      const store = createWorkflowStore();
      const run = store.createRun(buildAgentTeamWorkflow(kind, body.objective));
      store.appendEvent(run.id, "run_created", { source: "api" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, run }));
    } catch (e) {
      logger.error("workflow_create_failed", e);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/workflows/") && url.endsWith("/run") && req.method === "POST") {
    const id = decodeURIComponent(url.slice("/api/workflows/".length, -"/run".length));
    try {
      const store = createWorkflowStore();
      const run = findApiWorkflowRun(store, id);
      if (!run) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "workflow not found" })); return true; }
      const result = await runWorkflow({
        store,
        runId: run.id,
        executor: async ({ phase }) => ({
          output: `阶段 ${phase.name} 已由 workflow runtime 标记完成。实际业务执行器可在 runtime executor 中接入 agent/tool。`,
          artifacts: [{ name: `${phase.name}.txt`, contentType: "text/plain", content: `owner=${phase.owner}\noutput=${phase.outputName}` }],
        }),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, run: result }));
    } catch (e) {
      logger.error("workflow_run_failed", e, { id });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return true;
  }

  if (url.startsWith("/api/workflows/") && req.method === "GET") {
    const id = decodeURIComponent(url.slice("/api/workflows/".length));
    const store = createWorkflowStore();
    const run = findApiWorkflowRun(store, id);
    if (!run) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "workflow not found" })); return true; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ run, events: store.listEvents(run.id), artifacts: store.listArtifacts(run.id) }));
    return true;
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────────

  if (url === "/api/hooks/reload" && req.method === "POST") {
    reloadHooks();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (url === "/api/env/reload" && req.method === "POST") {
    const { reloadEnv } = await import("../server.js");
    reloadEnv();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

function findApiWorkflowRun(store: ReturnType<typeof createWorkflowStore>, idOrPrefix: string) {
  return store.getRun(idOrPrefix) ?? store.listRuns(500).find(r => r.id.startsWith(idOrPrefix));
}

function gitUrlToRaw(gitUrl: string): string {
  const m = gitUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)\/(.+)/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/refs/heads/${m[3]}/${m[4]}/SKILL.md`;
  const m2 = gitUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (m2) return `https://raw.githubusercontent.com/${m2[1]}/${m2[2]}/refs/heads/main/SKILL.md`;
  return gitUrl;
}
