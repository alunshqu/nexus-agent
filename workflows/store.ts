import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import { mkdirSync } from "fs";
import type { AgentTeamWorkflow } from "./agent-team.js";
import type { WorkflowRun, WorkflowRunPhase } from "./runner.js";
import { buildWorkflowRun } from "./runner.js";

export type WorkflowEvent = {
  id: string;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: number;
};

export type WorkflowArtifact = {
  id: string;
  runId: string;
  phaseName: string;
  name: string;
  contentType: string;
  content: string;
  createdAt: number;
};

export type WorkflowStore = ReturnType<typeof createWorkflowStore>;

const DEFAULT_DB_PATH = path.join(os.homedir(), ".agent", "workflows.db");

export function createWorkflowStore(dbPath = DEFAULT_DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      objective TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      phases_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      locked_by TEXT,
      lock_expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_name TEXT NOT NULL,
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run ON workflow_artifacts(run_id, created_at);
  `);

  function createRun(workflow: AgentTeamWorkflow): WorkflowRun {
    const run = buildWorkflowRun(workflow);
    db.prepare(`INSERT INTO workflow_runs
      (id, kind, objective, workflow_json, phases_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, workflow.kind, workflow.objective, JSON.stringify(workflow), JSON.stringify(run.phases), run.status, run.createdAt, run.updatedAt);
    return run;
  }

  function getRun(id: string): WorkflowRun | undefined {
    const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as any;
    return row ? rowToRun(row) : undefined;
  }

  function saveRun(run: WorkflowRun): void {
    db.prepare(`UPDATE workflow_runs SET workflow_json=?, phases_json=?, status=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(run.workflow), JSON.stringify(run.phases), run.status, run.updatedAt, run.id);
  }

  function listRuns(limit = 50): WorkflowRun[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (db.prepare(`SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?`).all(safeLimit) as any[]).map(rowToRun);
  }

  function listRunnableRuns(limit = 20): WorkflowRun[] {
    const now = Date.now();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return (db.prepare(`
      SELECT * FROM workflow_runs
      WHERE status IN ('pending', 'running') AND (lock_expires_at IS NULL OR lock_expires_at <= ?)
      ORDER BY updated_at ASC LIMIT ?
    `).all(now, safeLimit) as any[]).map(rowToRun);
  }

  function appendEvent(runId: string, type: string, payload: unknown = {}): WorkflowEvent {
    const event: WorkflowEvent = { id: randomUUID(), runId, type, payload: sanitizePayload(payload), createdAt: Date.now() };
    db.prepare("INSERT INTO workflow_events (id, run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.id, runId, type, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  function listEvents(runId: string): WorkflowEvent[] {
    return (db.prepare("SELECT * FROM workflow_events WHERE run_id = ? ORDER BY created_at ASC").all(runId) as any[]).map(row => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  function saveArtifact(runId: string, phaseName: string, name: string, contentType: string, content: string): WorkflowArtifact {
    const artifact: WorkflowArtifact = { id: randomUUID(), runId, phaseName, name, contentType, content, createdAt: Date.now() };
    db.prepare(`INSERT INTO workflow_artifacts (id, run_id, phase_name, name, content_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, runId, phaseName, name, contentType, content, artifact.createdAt);
    return artifact;
  }

  function listArtifacts(runId: string): WorkflowArtifact[] {
    return (db.prepare("SELECT * FROM workflow_artifacts WHERE run_id = ? ORDER BY created_at ASC").all(runId) as any[]).map(row => ({
      id: row.id,
      runId: row.run_id,
      phaseName: row.phase_name,
      name: row.name,
      contentType: row.content_type,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  function acquireRunLock(runId: string, workerId: string, ttlMs: number): boolean {
    const now = Date.now();
    const expires = now + Math.max(1_000, ttlMs);
    const result = db.prepare(`
      UPDATE workflow_runs SET locked_by=?, lock_expires_at=?, updated_at=?
      WHERE id=? AND (locked_by IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
    `).run(workerId, expires, now, runId, now);
    return result.changes === 1;
  }

  function releaseRunLock(runId: string, workerId: string): void {
    db.prepare("UPDATE workflow_runs SET locked_by=NULL, lock_expires_at=NULL, updated_at=? WHERE id=? AND locked_by=?")
      .run(Date.now(), runId, workerId);
  }

  function close(): void {
    db.close();
  }

  return { createRun, getRun, saveRun, listRuns, listRunnableRuns, appendEvent, listEvents, saveArtifact, listArtifacts, acquireRunLock, releaseRunLock, close };
}

function rowToRun(row: any): WorkflowRun {
  return {
    id: row.id,
    workflow: JSON.parse(row.workflow_json) as AgentTeamWorkflow,
    status: row.status,
    phases: JSON.parse(row.phases_json) as WorkflowRunPhase[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizePayload(payload: unknown): unknown {
  if (payload === undefined) return null;
  return JSON.parse(JSON.stringify(payload, (_, value) => typeof value === "bigint" ? value.toString() : value));
}
