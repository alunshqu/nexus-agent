import { promises as fs } from "fs";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";
import type { SessionState } from "../domain/types.js";
import { resolvePath, globToRegExp, walk, looksBinary, normalizeSlashes, expectString, clampNumber, truncate, countOccurrences } from "./helpers.js";

export const filesystemTools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a text file with line numbers. Default limit is 500 lines — if the file is larger, the output will tell you how many lines remain and what offset to use next. Use grep first to locate the target lines, then read a small window around them with offset+limit.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based starting line." },
        limit: { type: "number", description: "Max lines to return. Defaults to 500." },
        raw: { type: "boolean", description: "Return raw text without line numbers." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file, creating parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Exact string replacement in a file. Fails if old_string is not found or is ambiguous. Use grep to find the exact text first, then provide enough surrounding context in old_string to make it unique — do NOT read the whole file just to find the edit location.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List files and directories with metadata.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "glob",
    description: "Find files by glob pattern. Supports *, ?, **. Use *.ext for current directory only, **/*.ext for recursive search across all subdirectories.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        cwd: { type: "string" },
        max_results: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Search text files recursively using a regex. Use this BEFORE read_file or edit_file to locate the exact lines you need — avoids reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
        ignore_case: { type: "boolean" },
        max_results: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

const DEFAULT_READ_LIMIT = Number(process.env.READ_FILE_DEFAULT_LIMIT ?? 500);

export async function toolReadFile(state: SessionState, input: Record<string, unknown>) {
  const filePath = resolvePath(state, expectString(input.path, "path"));
  const text = await fs.readFile(filePath, "utf8");
  if (input.raw === true) return truncate(text);
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Math.floor(Number(input.offset ?? 1)));
  const limit = input.limit == null ? DEFAULT_READ_LIMIT : Math.max(1, Math.floor(Number(input.limit)));
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const rendered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");
  const remaining = lines.length - (offset - 1 + limit);
  const suffix = remaining > 0
    ? `\n... ${remaining} more lines (use offset=${offset + limit} to continue reading)`
    : "";
  return truncate(rendered + suffix);
}

export async function toolWriteFile(state: SessionState, input: Record<string, unknown>) {
  const filePath = resolvePath(state, expectString(input.path, "path"));
  const content = expectString(input.content, "content");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
}

export async function toolEditFile(state: SessionState, input: Record<string, unknown>) {
  const filePath = resolvePath(state, expectString(input.path, "path"));
  const oldString = expectString(input.old_string, "old_string");
  const newString = expectString(input.new_string, "new_string");
  const replaceAll = input.replace_all === true;
  const text = await fs.readFile(filePath, "utf8");
  const count = countOccurrences(text, oldString);
  if (count === 0) throw new Error("old_string not found");
  if (!replaceAll && count !== 1) throw new Error(`old_string occurs ${count} times; use replace_all=true or provide more context`);
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  await fs.writeFile(filePath, next, "utf8");
  return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${filePath}`;
}

export async function toolListDir(state: SessionState, input: Record<string, unknown>) {
  const dirPath = input.path ? resolvePath(state, expectString(input.path, "path")) : state.cwd;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const rows = await Promise.all(entries.map(async (e) => {
    const stat = await fs.stat(path.join(dirPath, e.name)).catch(() => undefined);
    return { name: e.name, type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file", size: stat?.size, modified: stat?.mtime.toISOString() };
  }));
  rows.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
  return truncate(JSON.stringify({ path: dirPath, entries: rows }, null, 2));
}

export async function toolGlob(state: SessionState, input: Record<string, unknown>) {
  const cwd = input.cwd ? resolvePath(state, expectString(input.cwd, "cwd")) : state.cwd;
  const pattern = expectString(input.pattern, "pattern");
  const maxResults = clampNumber(input.max_results, 200, 1, 5000);
  const matcher = globToRegExp(pattern);
  const results: string[] = [];
  await walk(cwd, async (fullPath, stat) => {
    if (results.length >= maxResults || !stat.isFile()) return;
    const rel = normalizeSlashes(path.relative(cwd, fullPath));
    if (matcher.test(rel)) results.push(rel);
  });
  return truncate(JSON.stringify({ cwd, pattern, count: results.length, results }, null, 2));
}

export async function toolGrep(state: SessionState, input: Record<string, unknown>) {
  const searchPath = input.path ? resolvePath(state, expectString(input.path, "path")) : state.cwd;
  const flags = input.ignore_case === true ? "i" : "";
  const regex = new RegExp(expectString(input.pattern, "pattern"), flags);
  const include = input.include ? globToRegExp(expectString(input.include, "include")) : undefined;
  const maxResults = clampNumber(input.max_results, 200, 1, 5000);
  const results: Array<{ file: string; line: number; text: string }> = [];
  const root = (await fs.stat(searchPath)).isDirectory() ? searchPath : path.dirname(searchPath);

  const visit = async (filePath: string) => {
    if (results.length >= maxResults) return;
    const rel = normalizeSlashes(path.relative(root, filePath));
    if (include && !include.test(rel)) return;
    if (await looksBinary(filePath)) return;
    const text = await fs.readFile(filePath, "utf8").catch(() => "");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (regex.test(lines[i])) results.push({ file: path.relative(state.cwd, filePath) || filePath, line: i + 1, text: lines[i] });
      regex.lastIndex = 0;
    }
  };

  const stat = await fs.stat(searchPath);
  if (stat.isDirectory()) {
    await walk(searchPath, async (fp, cs) => { if (cs.isFile()) await visit(fp); });
  } else {
    await visit(searchPath);
  }
  return truncate(JSON.stringify({ path: searchPath, pattern: input.pattern, count: results.length, results }, null, 2));
}
