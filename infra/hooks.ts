import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { createLogger } from "./logger.js";

const logger = createLogger("hooks");
const HOOKS_PATH = path.join(os.homedir(), ".agent", "hooks.json");
const DEFAULT_TIMEOUT_MS = 10_000;

export type HookName = "before_message" | "after_tool" | "on_done" | "on_error";

type HookConfig = { command: string; timeout_ms?: number };
type HooksConfig = Partial<Record<HookName, HookConfig>>;

let config: HooksConfig = {};

export function loadHooks() {
  if (!existsSync(HOOKS_PATH)) return;
  try {
    config = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
    logger.info("hooks_loaded", { hooks: Object.keys(config) });
  } catch (error) {
    logger.error("hooks_load_failed", error, { path: HOOKS_PATH });
  }
}

export function reloadHooks() {
  config = {};
  loadHooks();
}

// Fire-and-forget: runs hook in background, never blocks the agent loop.
// Passes context via environment variables — works on Windows (cmd.exe) and Unix (sh).
export function fireHook(name: HookName, env: Record<string, string>): void {
  const hook = config[name];
  if (!hook) return;

  const timeoutMs = hook.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const hookEnv = { ...process.env, ...prefixKeys(env) };

  const child = spawn(hook.command, {
    shell: true,   // Windows: cmd.exe, Unix: /bin/sh
    env: hookEnv,
    stdio: "pipe",
  });

  let stdout = "", stderr = "";
  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

  const timer = setTimeout(() => {
    child.kill();
    logger.warn("hook_timeout", { hook: name, command: hook.command, timeoutMs });
  }, timeoutMs);

  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      logger.warn("hook_nonzero_exit", { hook: name, code, stderr: stderr.slice(0, 500) });
    } else {
      logger.debug("hook_ok", { hook: name, stdout: stdout.slice(0, 200) });
    }
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    logger.error("hook_spawn_failed", error, { hook: name, command: hook.command });
  });
}

function prefixKeys(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[`HOOK_${k}`] = v;
  }
  return out;
}
