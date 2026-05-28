type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL = parseLevel(process.env.LOG_LEVEL ?? "info");
const MAX_STRING_LENGTH = Number(process.env.LOG_VALUE_LIMIT ?? 2000);
const MAX_DEPTH = 6;
const SENSITIVE_KEY = /(api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|password|bearer|x-api-key)/i;

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(component: string) {
  return {
    debug(event: string, context?: LogContext) {
      writeLog("debug", component, event, undefined, context);
    },
    info(event: string, context?: LogContext) {
      writeLog("info", component, event, undefined, context);
    },
    warn(event: string, context?: LogContext) {
      writeLog("warn", component, event, undefined, context);
    },
    error(event: string, error?: unknown, context?: LogContext) {
      writeLog("error", component, event, error, context);
    },
  };
}

export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const err = error as Error & Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: error.name,
      message: redactString(error.message),
      stack: error.stack ? redactString(error.stack) : undefined,
    };

    for (const key of ["status", "code", "type", "request_id", "requestId"] as const) {
      if (err[key] != null) out[key] = redact(err[key]);
    }

    if (err.cause != null) out.cause = serializeError(err.cause);
    if (err.error != null) out.apiError = redact(err.error);
    return out;
  }

  return redact(error);
}

export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>(), 0, undefined) as T;
}

export function truncateString(value: string, limit = MAX_STRING_LENGTH): string {
  if (value.length <= limit) return redactString(value);
  return `${redactString(value.slice(0, limit))}...[truncated ${value.length - limit} chars]`;
}

export function truncateValue(value: unknown, limit = MAX_STRING_LENGTH): unknown {
  if (typeof value === "string") return truncateString(value, limit);
  const json = safeJson(value);
  return json.length <= limit ? redact(value) : `${truncateString(json, limit)}`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return String(value);
  }
}

function formatTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function writeLog(level: LogLevel, component: string, event: string, error?: unknown, context?: LogContext) {
  if (!shouldLog(level)) return;

  const record: Record<string, unknown> = {
    time: formatTime(),
    level,
    component,
    event,
  };

  if (context && Object.keys(context).length > 0) record.context = redact(context);
  if (error !== undefined) record.error = serializeError(error);

  const line = safeJson(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[CURRENT_LEVEL];
}

function parseLevel(value: string): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number, key: string | undefined): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${(value as Function).name || "anonymous"}]`;
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => redactValue(item, seen, depth + 1, undefined));
    if (value.length > 50) items.push(`...[${value.length - 50} more]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactValue(childValue, seen, depth + 1, childKey);
  }
  return out;
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
