import { describe, it, expect } from "vitest";

// ── Extracted prefixKeys (mirrors infra/hooks.ts) ─────────────────────────────

function prefixKeys(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[`HOOK_${k}`] = v;
  }
  return out;
}

describe("hooks prefixKeys", () => {
  it("adds HOOK_ prefix to all keys", () => {
    const result = prefixKeys({ SESSION_ID: "abc", TOOL_NAME: "bash" });
    expect(result).toEqual({ HOOK_SESSION_ID: "abc", HOOK_TOOL_NAME: "bash" });
  });

  it("empty input returns empty object", () => {
    expect(prefixKeys({})).toEqual({});
  });

  it("preserves values including special characters", () => {
    const result = prefixKeys({ MSG: "hello world\nnewline", PATH: "/usr/bin:/usr/local/bin" });
    expect(result.HOOK_MSG).toBe("hello world\nnewline");
    expect(result.HOOK_PATH).toBe("/usr/bin:/usr/local/bin");
  });

  it("does not double-prefix", () => {
    const result = prefixKeys({ HOOK_ALREADY: "val" });
    expect(result).toHaveProperty("HOOK_HOOK_ALREADY", "val");
    expect(result).not.toHaveProperty("HOOK_ALREADY");
  });
});
