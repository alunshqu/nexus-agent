import { createLogger } from "./logger.js";

const logger = createLogger("metrics");

type Counter = { value: number; lastReset: number };
type Gauge = { value: number };

const counters: Record<string, Counter> = {};
const gauges: Record<string, Gauge> = {};

export function inc(name: string, by = 1) {
  if (!counters[name]) counters[name] = { value: 0, lastReset: Date.now() };
  counters[name].value += by;
}

export function gauge(name: string, value: number) {
  gauges[name] = { value };
}

export function getMetrics() {
  return {
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    counters: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, v.value])),
    gauges: Object.fromEntries(Object.entries(gauges).map(([k, v]) => [k, v.value])),
  };
}
