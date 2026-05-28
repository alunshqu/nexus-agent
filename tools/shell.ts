import { spawn } from "child_process";
import { existsSync } from "fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { SessionState } from "../domain/types.js";
import { resolvePath, expectString, clampNumber, keepTail, truncate, formatError } from "./helpers.js";
import { saveSession } from "../infra/session.js";

const TOOL_OUTPUT_LIMIT = Number(process.env.TOOL_OUTPUT_LIMIT ?? 20000);
const DEFAULT_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS ?? 120000);

export const bashTool: Anthropic.Tool = {
  name: "bash",
  description: "Run a shell command on the server. Use for builds, scripts, git, system inspection, and any CLI task. Prefer targeted commands (grep, head, tail, wc) over commands that dump large output — pipe through head/grep when output could be large.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      cwd: { type: "string", description: "Optional working directory." },
      timeout_ms: { type: "number", description: "Optional timeout in milliseconds." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const setCwdTool: Anthropic.Tool = {
  name: "set_cwd",
  description: "Permanently change the working directory for this session. All subsequent bash commands and file operations will use this directory by default. Use this when the user asks to switch projects or work in a different directory.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to switch to." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export function toolSetCwd(state: SessionState, input: Record<string, unknown>): string {
  const rawPath = expectString(input.path, "path");
  const resolved = resolvePath(state, rawPath);
  if (!existsSync(resolved)) return JSON.stringify({ error: `Directory not found: ${resolved}` });
  state.cwd = resolved;
  saveSession(state);
  return JSON.stringify({ cwd: resolved, ok: true });
}

export async function toolBash(state: SessionState, input: Record<string, unknown>) {
  const command = expectString(input.command, "command");
  const cwd = input.cwd ? resolvePath(state, expectString(input.cwd, "cwd")) : state.cwd;
  const timeoutMs = clampNumber(input.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 10 * 60 * 1000);

  return new Promise<string>((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", command], { cwd, env: process.env });
    state.activeChildren.add(child as any);
    let stdout = "", stderr = "", timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); stdout = keepTail(stdout, TOOL_OUTPUT_LIMIT); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); stderr = keepTail(stderr, TOOL_OUTPUT_LIMIT); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      state.activeChildren.delete(child as any);
      resolve(truncate(JSON.stringify({ cwd, command, exit_code: code, signal, timed_out: timedOut, stdout, stderr }, null, 2)));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      state.activeChildren.delete(child as any);
      resolve(JSON.stringify({ cwd, command, error: formatError(error) }, null, 2));
    });
  });
}
