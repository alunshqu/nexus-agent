import { describe, it, expect } from "vitest";
import { stableStringify, toolCallSignature } from "../tools/tool-dedupe.js";

describe("tool call dedupe", () => {
  it("creates the same signature for object inputs with different key order", () => {
    expect(toolCallSignature("web_fetch", { url: "http://localhost:8080/api/metrics", method: "GET" }))
      .toBe(toolCallSignature("web_fetch", { method: "GET", url: "http://localhost:8080/api/metrics" }));
  });

  it("keeps different tools or different inputs distinct", () => {
    expect(toolCallSignature("web_fetch", { url: "https://a.example" }))
      .not.toBe(toolCallSignature("web_search", { url: "https://a.example" }));
    expect(toolCallSignature("web_fetch", { url: "https://a.example" }))
      .not.toBe(toolCallSignature("web_fetch", { url: "https://b.example" }));
  });

  it("sorts nested object keys deterministically", () => {
    expect(stableStringify({ headers: { b: 2, a: 1 }, url: "x" }))
      .toBe('{"headers":{"a":1,"b":2},"url":"x"}');
  });
});
