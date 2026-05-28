import { describe, it, expect } from "vitest";
import { formatTokenUsage } from "../infra/usage.js";

describe("formatTokenUsage", () => {
  it("formats basic token usage", () => {
    expect(formatTokenUsage({ input_tokens: 1200, output_tokens: 345 })).toBe(
      "Token 使用：input 1,200，output 345，total 1,545"
    );
  });

  it("includes cache usage when present", () => {
    expect(formatTokenUsage({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 })).toBe(
      "Token 使用：input 100，output 50，total 150；cache 创建 30，cache 命中 20"
    );
  });
});
