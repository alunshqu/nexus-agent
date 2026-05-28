import { WebSocket } from "ws";
import { runAgent, interruptAgent } from "../domain/agent.js";
import type { AgentOptions, SessionState } from "../domain/types.js";
import { createSession, loadSession, saveSession, saveMessage, prepareForNewUserMessage, registerSession, unregisterSession, updateSessionStatus } from "../infra/session.js";
import { handleSlashCommand } from "../commands.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("websocket");

export function handleWebSocket(ws: WebSocket, url: string, opts: Omit<AgentOptions, "onEvent">) {
  const params = new URLSearchParams(url.includes("?") ? url.split("?")[1] : "");
  const existingId = params.get("session_id");
  const state: SessionState = (existingId ? loadSession(existingId) : null) ?? createSession(existingId ?? undefined);

  if (existingId && state.messages.length > 0) {
    logger.info("reconnected", { sessionId: state.id, messageCount: state.messages.length });
  } else {
    logger.info("connected", { sessionId: state.id });
  }

  saveSession(state);
  registerSession(state.id, "websocket");
  updateSessionStatus(state.id, { messageCount: state.messages.length });
  send(ws, { type: "session.created", session_id: state.id, cwd: state.cwd });

  // Send chat history on reconnect so UI can restore
  if (state.messages.length > 0) {
    send(ws, { type: "session.history", messages: state.messages.map(simplifyMessage) });
  }

  ws.on("message", async (data: Buffer) => {
    let msg: { type: string; text?: string };
    try { msg = JSON.parse(data.toString()); }
    catch { send(ws, { type: "error", message: "Invalid JSON" }); return; }

    if (msg.type === "interrupt") {
      interruptAgent(state);
      send(ws, { type: "session.interrupted" });
      return;
    }

    if (msg.type !== "user.message" || !msg.text?.trim()) return;

    const text = msg.text.trim();

    // Slash commands are highest priority — handle before running check
    if (text.startsWith("/")) {
      if (text === "/stop" || text === "/interrupt") {
        interruptAgent(state);
        send(ws, { type: "agent.message", text: "已中断。" });
        send(ws, { type: "session.idle", cwd: state.cwd });
        return;
      }
      const result = await handleSlashCommand(text, state, opts);
      if (result) {
        send(ws, { type: "agent.message", text: result });
        send(ws, { type: "session.idle", cwd: state.cwd });
        return;
      }
    }

    if (state.running) { send(ws, { type: "error", message: "Agent is running. Send interrupt first." }); return; }

    state.running = true;
    prepareForNewUserMessage(state);
    state.messages.push({ role: "user", content: text });
    saveMessage(state.id, "user", text);

    let lastTraceId: string | undefined;
    let lastUsage: any;
    try {
      await runAgent(state, {
        ...opts,
        onEvent: (event) => {
          if (event.type === "text") send(ws, { type: "agent.message", text: event.delta });
          else if (event.type === "tool_use") send(ws, { type: "agent.tool_use", tool: event.name, input: event.input });
          else if (event.type === "tool_result") send(ws, { type: "agent.tool_result", tool: event.name, result: event.result, is_error: event.is_error });
          else if (event.type === "done") { lastTraceId = event.traceId; lastUsage = event.usage; }
          else if (event.type === "error") send(ws, { type: "error", message: event.message });
        },
      });
    } catch (error) {
      logger.error("run_agent_exception", error, { sessionId: state.id, entrypoint: "websocket", traceId: lastTraceId });
      send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      state.running = false;
      state.currentStream = undefined;
      send(ws, { type: "session.idle", cwd: state.cwd, trace_id: lastTraceId, usage: lastUsage });
    }
  });

  ws.on("close", () => {
    logger.info("disconnected", { sessionId: state.id });
    unregisterSession(state.id);
    interruptAgent(state);
  });
}

function send(ws: WebSocket, payload: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function simplifyMessage(msg: any): { role: string; text?: string; tools?: any[] } {
  const role = msg.role;
  if (typeof msg.content === "string") return { role, text: msg.content };
  if (!Array.isArray(msg.content)) return { role };

  const texts = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const toolUses = msg.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ name: b.name, input: b.input }));
  const toolResults = msg.content.filter((b: any) => b.type === "tool_result").map((b: any) => ({
    name: b.tool_use_id,
    result: typeof b.content === "string" ? b.content.slice(0, 500) : JSON.stringify(b.content).slice(0, 500),
    is_error: b.is_error,
  }));

  return { role, text: texts || undefined, tools: [...toolUses, ...toolResults].length > 0 ? [...toolUses, ...toolResults] : undefined };
}
