import type { IncomingMessage, ServerResponse } from "http";
import { runAgent } from "../domain/agent.js";
import type { AgentOptions } from "../domain/types.js";
import { createSession, loadSession, saveSession, saveMessage, prepareForNewUserMessage, setInMemorySession, registerSession, updateSessionStatus } from "../infra/session.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("http");

export async function handleHttpChat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Omit<AgentOptions, "onEvent">
) {
  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed: { text: string; session_id?: string };
  try { parsed = JSON.parse(body); }
  catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

  if (!parsed.text?.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: "text is required" })); return; }

  const state = (parsed.session_id ? loadSession(parsed.session_id) : null) ?? createSession(parsed.session_id);
  setInMemorySession(state.id, state);
  registerSession(state.id, "http");
  saveSession(state);
  state.running = true;
  prepareForNewUserMessage(state);
  state.messages.push({ role: "user", content: parsed.text.trim() });
  saveMessage(state.id, "user", parsed.text.trim());

  const isStream = req.url?.includes("/stream");

  if (isStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Session-Id": state.id,
    });
    const write = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      await runAgent(state, {
        ...opts,
        onEvent: (event) => {
          if (event.type === "text") write({ type: "text", delta: event.delta });
          else if (event.type === "tool_use") write({ type: "tool_use", name: event.name, input: event.input });
          else if (event.type === "tool_result") write({ type: "tool_result", name: event.name, result: event.result, is_error: event.is_error });
          else if (event.type === "error") write({ type: "error", message: event.message });
        },
      });
      write({ type: "done", session_id: state.id });
    } catch (error) {
      logger.error("run_agent_exception", error, { sessionId: state.id, entrypoint: "http_stream" });
      write({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      state.running = false;
      state.currentStream = undefined;
      updateSessionStatus(state.id, { running: false, currentTool: undefined, currentPhase: undefined, messageCount: state.messages.length });
      res.end();
    }
  } else {
    const parts: string[] = [];
    try {
      await runAgent(state, {
        ...opts,
        onEvent: (event) => { if (event.type === "text") parts.push(event.delta); },
      });
      state.running = false;
      state.currentStream = undefined;
      updateSessionStatus(state.id, { running: false, currentTool: undefined, currentPhase: undefined, messageCount: state.messages.length });
      res.writeHead(200, { "Content-Type": "application/json", "X-Session-Id": state.id });
      res.end(JSON.stringify({ session_id: state.id, text: parts.join("") }));
    } catch (error) {
      logger.error("run_agent_exception", error, { sessionId: state.id, entrypoint: "http_json" });
      state.running = false;
      state.currentStream = undefined;
      updateSessionStatus(state.id, { running: false });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export function handleSessionGet(req: IncomingMessage, res: ServerResponse) {
  const id = req.url?.split("/").pop();
  if (!id) { res.writeHead(400); res.end(); return; }
  const session = loadSession(id);
  if (!session) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: session.id, cwd: session.cwd, message_count: session.messages.length }));
}
