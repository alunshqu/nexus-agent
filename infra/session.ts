import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChildProcess } from "child_process";
import type { ChannelCapabilities } from "../domain/types.js";

export type SessionStatus = {
  sessionId: string;
  channel: string;       // "websocket" | "wecom" | "http" | etc.
  running: boolean;
  messageCount: number;
  currentTool?: string;  // tool being executed right now
  currentPhase?: string; // agent loop phase
  startedAt?: number;    // when current run started
  lastActivity: number;
};

// Global registry of active sessions across all adapters
const activeRegistry = new Map<string, SessionStatus>();
const registryListeners = new Set<(statuses: SessionStatus[]) => void>();

export function registerSession(sessionId: string, channel: string) {
  activeRegistry.set(sessionId, { sessionId, channel, running: false, messageCount: 0, lastActivity: Date.now() });
  notifyListeners();
}

export function unregisterSession(sessionId: string) {
  activeRegistry.delete(sessionId);
  notifyListeners();
}

export function updateSessionStatus(sessionId: string, update: Partial<SessionStatus>) {
  const existing = activeRegistry.get(sessionId);
  if (existing) {
    activeRegistry.set(sessionId, { ...existing, ...update, lastActivity: Date.now() });
    notifyListeners();
  }
}

export function getActiveSessions(): SessionStatus[] {
  return [...activeRegistry.values()];
}

export function onSessionStatusChange(listener: (statuses: SessionStatus[]) => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

// Global in-memory session state map — shared across adapters
const inMemorySessions = new Map<string, SessionState>();

export function setInMemorySession(id: string, state: SessionState) {
  inMemorySessions.set(id, state);
}

export function getInMemorySession(id: string): SessionState | undefined {
  return inMemorySessions.get(id);
}

export function resetInMemorySessionRunning(id: string) {
  const state = inMemorySessions.get(id);
  if (state) {
    state.running = false;
    state.currentStream = undefined;
  }
}

function notifyListeners() {
  const statuses = getActiveSessions();
  for (const l of registryListeners) l(statuses);
}

export type SessionState = {
  id: string;
  cwd: string;
  running: boolean;
  messages: Anthropic.MessageParam[];
  activeChildren: Set<ChildProcess>;
  currentStream?: { abort?: () => void };
  channel?: ChannelCapabilities;
  lastInputTokens?: number;
  channelId?: string;  // channel-specific user/chat identifier (e.g. wecom userid)
};

const DB_PATH = path.join(os.homedir(), ".agent", "sessions.db");
import { mkdirSync } from "fs";
import { createLogger } from "./logger.js";

const logger = createLogger("session");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// Add channel_id column if it doesn't exist (migration for existing DBs)
try { db.exec("ALTER TABLE sessions ADD COLUMN channel_id TEXT"); } catch { /* already exists */ }

const upsertSession = db.prepare(
  "INSERT INTO sessions (id, cwd, channel_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, channel_id=excluded.channel_id, updated_at=excluded.updated_at"
);
const insertMessage = db.prepare(
  "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)"
);
const deleteMessages = db.prepare("DELETE FROM messages WHERE session_id = ?");
const selectSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
const selectMessages = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC");

export function createSession(id?: string): SessionState {
  return {
    id: id ?? randomUUID(),
    cwd: process.cwd(),
    running: false,
    messages: [],
    activeChildren: new Set(),
  };
}

export function saveSession(state: SessionState) {
  upsertSession.run(state.id, state.cwd, state.channelId ?? null, Date.now());
}

export function saveMessage(sessionId: string, role: string, content: unknown) {
  insertMessage.run(sessionId, role, JSON.stringify(content), Date.now());
}

export function loadSession(id: string): SessionState | null {
  const row = selectSession.get(id) as any;
  if (!row) return null;
  const msgRows = selectMessages.all(id) as any[];
  const messages: Anthropic.MessageParam[] = msgRows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: JSON.parse(r.content),
  }));
  const before = messages.length;
  repairMessages(messages);
  if (messages.length !== before) {
    logger.warn("loaded_session_repaired", { sessionId: id, before, after: messages.length });
    rewriteMessages(id, messages);
  }
  return { id, cwd: row.cwd, running: false, messages, activeChildren: new Set(), channelId: row.channel_id ?? undefined };
}

export function prepareForNewUserMessage(state: SessionState) {
  repairSessionMessages(state);
  const before = state.messages.length;
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg?.role === "user") state.messages.pop();
  if (state.messages.length !== before) {
    logger.warn("new_user_message_removed_unanswered", { sessionId: state.id, before, after: state.messages.length });
    rewriteMessages(state.id, state.messages);
  }
}

export function repairSessionMessages(state: SessionState) {
  const before = state.messages.length;
  repairMessages(state.messages);
  if (state.messages.length !== before) {
    logger.warn("session_messages_repaired", { sessionId: state.id, before, after: state.messages.length });
    rewriteMessages(state.id, state.messages);
  }
}

export function rewriteSessionMessages(sessionId: string, messages: Anthropic.MessageParam[]) {
  rewriteMessages(sessionId, messages);
}

function rewriteMessages(sessionId: string, messages: Anthropic.MessageParam[]) {
  const rewrite = db.transaction(() => {
    deleteMessages.run(sessionId);
    for (const m of messages) {
      insertMessage.run(sessionId, m.role, JSON.stringify(m.content), Date.now());
    }
  });
  rewrite();
}

function repairMessages(messages: Anthropic.MessageParam[]) {
  // Drop trailing messages that leave the conversation in an invalid state
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    // Drop assistant with tool_use (no matching tool_result follows)
    if (last.role === "assistant" && Array.isArray(last.content) && (last.content as any[]).some(b => b.type === "tool_use")) {
      messages.pop();
      continue;
    }
    // Drop user with tool_result at the end (orphaned tool results)
    if (last.role === "user" && Array.isArray(last.content) && (last.content as any[]).some(b => b.type === "tool_result")) {
      messages.pop();
      continue;
    }
    break;
  }

  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    const validToolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content as any[]) if (b.type === "tool_use" && b.id) validToolUseIds.add(b.id);
      }
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const b of msg.content as any[]) if (b.type === "tool_result" && b.tool_use_id) toolResultIds.add(b.tool_use_id);
      }
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const blocks = (msg.content as any[]).filter(b => b.type !== "tool_use" || toolResultIds.has(b.id));
        if (blocks.length !== msg.content.length) {
          changed = true;
          if (blocks.length === 0 || blocks.every((b: any) => b.type === "thinking")) messages.splice(i, 1);
          else messages[i] = { ...msg, content: blocks as any };
        }
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        const blocks = (msg.content as any[]).filter(b => b.type !== "tool_result" || validToolUseIds.has(b.tool_use_id));
        if (blocks.length !== msg.content.length) {
          changed = true;
          if (blocks.length === 0) messages.splice(i, 1);
          else messages[i] = { ...msg, content: blocks as any };
        }
      }
    }

    if (!changed) break;
  }

  // Ensure no consecutive same-role messages
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role) {
      messages.splice(i, 1);
    }
  }
  // Must start with user
  while (messages.length > 0 && messages[0].role !== "user") {
    messages.shift();
  }
}
