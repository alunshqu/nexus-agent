import { createLogger } from "./logger.js";

const logger = createLogger("metrics");

type Counter = { value: number; lastReset: number };
type Gauge = { value: number };
type Timing = { count: number; totalMs: number; minMs: number; maxMs: number; lastMs: number };

const counters: Record<string, Counter> = {};
const gauges: Record<string, Gauge> = {};
const timings: Record<string, Timing> = {};

export function inc(name: string, by = 1) {
  if (!counters[name]) counters[name] = { value: 0, lastReset: Date.now() };
  counters[name].value += by;
}

export function gauge(name: string, value: number) {
  gauges[name] = { value };
}

export function counterValue(name: string): number {
  return counters[name]?.value ?? 0;
}

export function gaugeValue(name: string): number | undefined {
  return gauges[name]?.value;
}

export function timing(name: string, durationMs: number) {
  if (!Number.isFinite(durationMs)) return;
  const current = timings[name];
  if (!current) {
    timings[name] = { count: 1, totalMs: durationMs, minMs: durationMs, maxMs: durationMs, lastMs: durationMs };
    return;
  }
  current.count += 1;
  current.totalMs += durationMs;
  current.minMs = Math.min(current.minMs, durationMs);
  current.maxMs = Math.max(current.maxMs, durationMs);
  current.lastMs = durationMs;
}

export async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timing(name, Date.now() - start);
  }
}

export function getMetrics() {
  return {
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    counters: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, v.value])),
    gauges: Object.fromEntries(Object.entries(gauges).map(([k, v]) => [k, v.value])),
    timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, {
      count: v.count,
      total_ms: Math.round(v.totalMs),
      avg_ms: Math.round(v.totalMs / v.count),
      min_ms: Math.round(v.minMs),
      max_ms: Math.round(v.maxMs),
      last_ms: Math.round(v.lastMs),
    }])),
  };
}
