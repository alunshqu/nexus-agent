import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { SessionState } from "../domain/types.js";

const TOOL_OUTPUT_LIMIT = Number(process.env.TOOL_OUTPUT_LIMIT ?? 20000);

export function resolvePath(state: SessionState, inputPath: string) {
  if (inputPath.startsWith("~")) return path.join(os.homedir(), inputPath.slice(1));
  return path.resolve(state.cwd, inputPath);
}

export function globToRegExp(pattern: string) {
  const normalized = normalizeSlashes(pattern);
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i], next = normalized[i + 1];
    if (char === "*" && next === "*") { out += ".*"; i++; }
    else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += escapeRegExp(char);
  }
  return new RegExp(out + "$");
}

export async function walk(root: string, onFile: (fullPath: string, stat: Awaited<ReturnType<typeof fs.stat>>) => Promise<void> | void) {
  const ignored = new Set([".git", "node_modules", ".DS_Store", "dist", "build", "coverage"]);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    const stat = await fs.stat(fullPath).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory()) await walk(fullPath, onFile);
    else await onFile(fullPath, stat);
  }
}

export async function looksBinary(filePath: string) {
  const buffer = await fs.readFile(filePath).catch(() => Buffer.alloc(0));
  return buffer.subarray(0, 4096).includes(0);
}

export function normalizeSlashes(v: string) { return v.split(path.sep).join("/"); }
export function escapeRegExp(v: string) { return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function countOccurrences(text: string, needle: string) {
  if (needle === "") throw new Error("old_string cannot be empty");
  let count = 0, index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) { count++; index += needle.length; }
  return count;
}

export function truncate(value: string, limit = TOOL_OUTPUT_LIMIT) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... truncated ${value.length - limit} chars`;
}

export function keepTail(value: string, limit: number) {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(value);
  return !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, Math.floor(n)));
}

export function expectString(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatError(error: unknown) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function decodeDuckDuckGoUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch { return rawUrl; }
}

export function stripHtml(value: string) { return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()); }

export function decodeHtml(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
