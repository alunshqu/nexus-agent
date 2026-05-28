import Database from "better-sqlite3";
import path from "path";
import os from "os";
import { mkdirSync } from "fs";

export type TraceEvent =
  | { type: "llm_call"; iteration: number; model: string; systemPrompt: string; messages: any[]; ts: number }
  | { type: "llm_response"; iteration: number; stopReason: string; content: any[]; usage?: any; ts: number }
  | { type: "tool_call"; name: string; input: unknown; ts: number }
  | { type: "tool_result"; name: string; result: string; is_error: boolean; durationMs: number; ts: number }
  | { type: "done"; totalMs: number; totalUsage: any; ts: number }
  | { type: "error"; message: string; phase?: string; details?: unknown; stack?: string; ts: number };

export type Trace = {
  id: string;
  sessionId: string;
  userMessage: string;
  model: string;
  startTs: number;
  events: TraceEvent[];
  endTs?: number;
};

const DB_PATH = path.join(os.homedir(), ".agent", "traces.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_message TEXT NOT NULL,
    model TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER,
    events TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, start_ts);
`);

const insertTrace = db.prepare("INSERT INTO traces (id, session_id, user_message, model, start_ts, events) VALUES (?, ?, ?, ?, ?, ?)");
const updateTrace = db.prepare("UPDATE traces SET end_ts = ?, events = ? WHERE id = ?");
const selectTraces = db.prepare("SELECT id, session_id, user_message, model, start_ts, end_ts, length(events) as events_len FROM traces WHERE session_id = ? ORDER BY start_ts ASC");
const selectTrace = db.prepare("SELECT * FROM traces WHERE id = ?");

export function addErrorEvent(trace: Trace, message: string, opts?: { phase?: string; details?: unknown; stack?: string }) {
  trace.events.push({
    type: "error",
    message,
    phase: opts?.phase,
    details: opts?.details,
    stack: opts?.stack,
    ts: Date.now(),
  });
}

export function startTrace(sessionId: string, userMessage: string, model: string): Trace {
  const trace: Trace = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId, userMessage, model, startTs: Date.now(), events: [],
  };
  insertTrace.run(trace.id, sessionId, userMessage, model, trace.startTs, "[]");
  return trace;
}

export function finalizeTrace(trace: Trace) {
  updateTrace.run(trace.endTs ?? null, JSON.stringify(trace.events), trace.id);
}

const selectAllTraces = db.prepare("SELECT id, session_id, user_message, model, start_ts, end_ts FROM traces ORDER BY start_ts DESC LIMIT 100");

export function getAllTraces(): Array<{ id: string; sessionId: string; userMessage: string; model: string; startTs: number; endTs?: number; eventCount: number }> {
  return (selectAllTraces.all() as any[]).map(row => ({
    id: row.id,
    sessionId: row.session_id,
    userMessage: row.user_message,
    model: row.model,
    startTs: row.start_ts,
    endTs: row.end_ts ?? undefined,
    eventCount: JSON.parse((selectTrace.get(row.id) as any)?.events ?? "[]").length,
  }));
}

export function getTraces(sessionId: string): Array<{ id: string; userMessage: string; model: string; startTs: number; endTs?: number; eventCount: number }> {
  return (selectTraces.all(sessionId) as any[]).map(row => ({
    id: row.id,
    userMessage: row.user_message,
    model: row.model,
    startTs: row.start_ts,
    endTs: row.end_ts ?? undefined,
    eventCount: JSON.parse((selectTrace.get(row.id) as any)?.events ?? "[]").length,
  }));
}

export function getTrace(sessionId: string, traceId: string): Trace | undefined {
  const row = selectTrace.get(traceId) as any;
  if (!row || row.session_id !== sessionId) return undefined;
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessage: row.user_message,
    model: row.model,
    startTs: row.start_ts,
    endTs: row.end_ts ?? undefined,
    events: JSON.parse(row.events),
  };
}
