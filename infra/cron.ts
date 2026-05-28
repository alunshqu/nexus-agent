import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";
import { createLogger } from "./logger.js";

const logger = createLogger("cron");
const DB_PATH = path.join(os.homedir(), ".agent", "sessions.db");

export type CronJob = {
  id: string;
  name: string;
  cron: string;       // standard 5-field: "0 9 * * *"
  task: string;       // prompt sent to agent
  channel?: string;   // session id to push result to, or undefined
  enabled: boolean;
  last_run?: number;
  next_run: number;
  created_at: number;
};

// ── DB setup ──────────────────────────────────────────────────────────────────

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS crons (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        task TEXT NOT NULL,
        channel TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run INTEGER,
        next_run INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }
  return db;
}

// ── Cron expression parser ────────────────────────────────────────────────────
// Supports standard 5-field cron: minute hour day-of-month month day-of-week
// Supports: * (any), */n (step), n (exact), n-m (range), n,m (list)

function matchField(value: number, expr: string, min: number, max: number): boolean {
  if (expr === "*") return true;
  for (const part of expr.split(",")) {
    if (part.includes("/")) {
      const [range, step] = part.split("/");
      const s = Number(step);
      const [lo, hi] = range === "*" ? [min, max] : range.split("-").map(Number);
      for (let i = lo; i <= hi; i += s) {
        if (i === value) return true;
      }
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (Number(part) === value) return true;
    }
  }
  return false;
}

export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    matchField(date.getMinutes(), min, 0, 59) &&
    matchField(date.getHours(), hour, 0, 23) &&
    matchField(date.getDate(), dom, 1, 31) &&
    matchField(date.getMonth() + 1, mon, 1, 12) &&
    matchField(date.getDay(), dow, 0, 6)
  );
}

// Compute next fire time after `from` (scans minute by minute, max 1 year)
export function nextRun(cron: string, from: Date = new Date()): number {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (d < limit) {
    if (cronMatches(cron, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return -1;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function listCrons(): CronJob[] {
  return getDb().prepare("SELECT * FROM crons ORDER BY created_at ASC").all() as any[];
}

export function getCron(id: string): CronJob | undefined {
  return getDb().prepare("SELECT * FROM crons WHERE id = ?").get(id) as any;
}

export function addCron(job: Omit<CronJob, "id" | "next_run" | "created_at">): CronJob {
  const id = randomUUID();
  const now = Date.now();
  const next = nextRun(job.cron);
  if (next < 0) throw new Error(`Invalid or unmatchable cron expression: ${job.cron}`);
  getDb().prepare(
    "INSERT INTO crons (id, name, cron, task, channel, enabled, last_run, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, job.name, job.cron, job.task, job.channel ?? null, job.enabled ? 1 : 0, null, next, now);
  logger.info("cron_added", { id, name: job.name, cron: job.cron, next: new Date(next).toISOString() });
  return getCron(id)!;
}

export function updateCron(id: string, patch: Partial<Pick<CronJob, "name" | "cron" | "task" | "channel" | "enabled">>): CronJob {
  const existing = getCron(id);
  if (!existing) throw new Error(`Cron not found: ${id}`);
  const merged = { ...existing, ...patch };
  const next = nextRun(merged.cron);
  if (next < 0) throw new Error(`Invalid cron expression: ${merged.cron}`);
  getDb().prepare(
    "UPDATE crons SET name=?, cron=?, task=?, channel=?, enabled=?, next_run=? WHERE id=?"
  ).run(merged.name, merged.cron, merged.task, merged.channel ?? null, merged.enabled ? 1 : 0, next, id);
  return getCron(id)!;
}

export function deleteCron(id: string): boolean {
  const result = getDb().prepare("DELETE FROM crons WHERE id = ?").run(id);
  return result.changes > 0;
}

function markRan(id: string): void {
  const now = Date.now();
  const job = getCron(id);
  if (!job) return;
  const next = nextRun(job.cron, new Date(now));
  getDb().prepare("UPDATE crons SET last_run=?, next_run=? WHERE id=?").run(now, next, id);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

type RunnerFn = (job: CronJob) => Promise<void>;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

export function startScheduler(runner: RunnerFn): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => tick(runner), 60_000);
  logger.info("scheduler_started");
}

export function stopScheduler(): void {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = undefined; }
}

const MAX_CONCURRENT_JOBS = Number(process.env.CRON_MAX_CONCURRENT ?? 3);

function tick(runner: RunnerFn): void {
  const now = Date.now();
  const due = listCrons().filter(j => j.enabled && j.next_run <= now);
  if (due.length === 0) return;

  // Mark all as ran before firing (prevents double-fire if runner is slow)
  for (const job of due) markRan(job.id);

  // Run in parallel with concurrency limit
  const chunks: CronJob[][] = [];
  for (let i = 0; i < due.length; i += MAX_CONCURRENT_JOBS) {
    chunks.push(due.slice(i, i + MAX_CONCURRENT_JOBS));
  }

  (async () => {
    for (const chunk of chunks) {
      await Promise.all(chunk.map(job => {
        logger.info("cron_firing", { id: job.id, name: job.name, cron: job.cron });
        return runner(job).catch(error => {
          logger.error("cron_run_failed", error, { id: job.id, name: job.name });
        });
      }));
    }
  })();
}
