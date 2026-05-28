import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import os from "os";
import { mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { embed, getEmbeddingDim } from "./embeddings.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("memory_store");

const DB_PATH = path.join(os.homedir(), ".agent", "memory.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
sqliteVec.load(db);

const DIM = getEmbeddingDim();

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    session_id TEXT,
    source TEXT DEFAULT 'extracted',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    valid_from INTEGER,
    valid_until INTEGER,
    access_count INTEGER DEFAULT 0,
    last_accessed INTEGER
  );

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    valid_until INTEGER
  );

  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object_id TEXT,
    object_text TEXT,
    confidence REAL DEFAULT 1.0,
    source TEXT DEFAULT 'extracted',
    created_at INTEGER NOT NULL,
    valid_until INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
  CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(valid_until);
  CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id);
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
`);

// Vector table (created separately since virtual table syntax differs)
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[${DIM}])`);

const insertVec = db.prepare("INSERT INTO memory_vec (memory_id, embedding) VALUES (?, ?)");
const deleteVec = db.prepare("DELETE FROM memory_vec WHERE memory_id = ?");

export type Memory = {
  id: string;
  content: string;
  type: "user_profile" | "project_knowledge" | "decision" | "skill" | "correction";
  tags: string[];
  session_id?: string;
  source: "user_explicit" | "extracted" | "inferred";
  created_at: number;
  updated_at: number;
  valid_from?: number;
  valid_until?: number;
  access_count: number;
  last_accessed?: number;
};

export type Entity = {
  id: string;
  name: string;
  type: string;
  content: string;
};

export type Fact = {
  id: string;
  subject_id: string;
  predicate: string;
  object_id?: string;
  object_text?: string;
  confidence: number;
  source: string;
};

// ── Memory CRUD ───────────────────────────────────────────────────────────────

const insertMemory = db.prepare(`
  INSERT INTO memories (id, content, type, tags, session_id, source, created_at, updated_at, valid_from)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateMemoryContent = db.prepare(`
  UPDATE memories SET content = ?, updated_at = ?, tags = ? WHERE id = ?
`);

const invalidateMemory = db.prepare(`
  UPDATE memories SET valid_until = ? WHERE id = ?
`);

const deleteMemory = db.prepare(`DELETE FROM memories WHERE id = ?`);

const selectActiveMemories = db.prepare(`
  SELECT * FROM memories WHERE valid_until IS NULL ORDER BY updated_at DESC LIMIT ?
`);

const selectMemoriesByType = db.prepare(`
  SELECT * FROM memories WHERE type = ? AND valid_until IS NULL ORDER BY updated_at DESC LIMIT ?
`);

const searchMemoriesFTS = db.prepare(`
  SELECT * FROM memories WHERE valid_until IS NULL AND content LIKE ? ORDER BY updated_at DESC LIMIT ?
`);

const touchMemory = db.prepare(`
  UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?
`);

export function saveMemory(content: string, type: Memory["type"], opts?: { tags?: string[]; sessionId?: string; source?: Memory["source"] }): Memory {
  const id = randomUUID();
  const now = Date.now();
  const tags = opts?.tags ?? [];
  insertMemory.run(id, content, type, JSON.stringify(tags), opts?.sessionId ?? null, opts?.source ?? "extracted", now, now, now);
  // Async embedding — don't block on it
  embed(content)
    .then(vec => {
      try { insertVec.run(id, Buffer.from(vec.buffer)); }
      catch (error) { logger.error("embedding_insert_failed", error, { memoryId: id, operation: "save" }); }
    })
    .catch((error) => { logger.error("embedding_failed", error, { memoryId: id, operation: "save" }); });
  return { id, content, type, tags, session_id: opts?.sessionId, source: opts?.source ?? "extracted", created_at: now, updated_at: now, valid_from: now, access_count: 0 };
}

export function updateMemory(id: string, content: string, tags?: string[]) {
  const existing = getMemoryById(id);
  if (!existing) return;
  updateMemoryContent.run(content, Date.now(), JSON.stringify(tags ?? existing.tags), id);
  // Re-embed
  embed(content)
    .then(vec => {
      try { deleteVec.run(id); insertVec.run(id, Buffer.from(vec.buffer)); }
      catch (error) { logger.error("embedding_insert_failed", error, { memoryId: id, operation: "update" }); }
    })
    .catch((error) => { logger.error("embedding_failed", error, { memoryId: id, operation: "update" }); });
}

export function expireMemory(id: string) {
  invalidateMemory.run(Date.now(), id);
}

export function removeMemory(id: string) {
  deleteMemory.run(id);
}

export function getMemoryById(id: string): Memory | null {
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
  return row ? rowToMemory(row) : null;
}

const DEFAULT_MEMORY_LIMIT = Number(process.env.MEMORY_LIST_LIMIT ?? 1000);

export function getActiveMemories(limit = DEFAULT_MEMORY_LIMIT): Memory[] {
  return (selectActiveMemories.all(limit) as any[]).map(rowToMemory);
}

export function getMemoriesByType(type: Memory["type"], limit = DEFAULT_MEMORY_LIMIT): Memory[] {
  return (selectMemoriesByType.all(type, limit) as any[]).map(rowToMemory);
}

export function searchMemories(query: string, limit = 20): Memory[] {
  const pattern = `%${query}%`;
  const results = (searchMemoriesFTS.all(pattern, limit) as any[]).map(rowToMemory);
  for (const m of results) touchMemory.run(Date.now(), m.id);
  return results;
}

export async function findSimilarMemories(content: string, threshold = 0.3, limit = 20): Promise<Memory[]> {
  try {
    const queryVec = await embed(content);
    const rows = db.prepare(`
      SELECT v.memory_id, v.distance
      FROM memory_vec v
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `).all(Buffer.from(queryVec.buffer), limit) as any[];

    const results: Memory[] = [];
    for (const row of rows) {
      if (row.distance > (1 - threshold)) continue; // cosine distance: 0=identical, 2=opposite
      const memory = getMemoryById(row.memory_id);
      if (memory && !memory.valid_until) results.push(memory);
    }
    return results;
  } catch (error) {
    logger.warn("vector_search_failed", { error: error instanceof Error ? error.message : String(error), threshold, limit });
    // Fallback to keyword matching if vector search fails. Keep this bounded so a
    // broken vector index cannot degrade into a full memory-table scan.
    const queryWords = new Set(extractKeywords(content));
    if (queryWords.size === 0) return [];
    const candidates = getActiveMemories(Math.max(limit * 20, 100));
    return candidates.filter(m => {
      const memWords = new Set(extractKeywords(m.content));
      const intersection = [...queryWords].filter(w => memWords.has(w)).length;
      const union = new Set([...queryWords, ...memWords]).size;
      return union > 0 && intersection / union >= threshold;
    }).slice(0, limit);
  }
}

// ── Entity/Fact CRUD ──────────────────────────────────────────────────────────

export function saveEntity(name: string, type: string, content: string): Entity {
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO entities (id, name, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, type, content, now, now);
  return { id, name, type, content };
}

export function saveFact(subjectId: string, predicate: string, objectText: string, source = "extracted"): Fact {
  const id = randomUUID();
  // Expire conflicting facts
  db.prepare("UPDATE facts SET valid_until = ? WHERE subject_id = ? AND predicate = ? AND valid_until IS NULL").run(Date.now(), subjectId, predicate);
  db.prepare("INSERT INTO facts (id, subject_id, predicate, object_text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, subjectId, predicate, objectText, source, Date.now());
  return { id, subject_id: subjectId, predicate, object_text: objectText, confidence: 1.0, source };
}

export function getEntityFacts(entityId: string): Fact[] {
  return db.prepare("SELECT * FROM facts WHERE subject_id = ? AND valid_until IS NULL").all(entityId) as Fact[];
}

export function findEntity(name: string): Entity | null {
  return db.prepare("SELECT * FROM entities WHERE name = ? AND valid_until IS NULL").get(name) as Entity | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToMemory(row: any): Memory {
  return { ...row, tags: JSON.parse(row.tags ?? "[]") };
}

function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w一-鿿\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);
}
