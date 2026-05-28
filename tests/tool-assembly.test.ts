import { describe, it, expect } from "vitest";
import { stableTools, buildAgentRegistryAttachment } from "../tools/tool-assembly.js";

const tool = (name: string, description = name) => ({
  name,
  description,
  input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
});

describe("tool assembly cache optimization", () => {
  it("sorts tools deterministically by name", () => {
    const result = stableTools([tool("z"), tool("a"), tool("m")]);
    expect(result.map(t => t.name)).toEqual(["a", "m", "z"]);
  });

  it("keeps agent_run schema static and excludes dynamic agent names from description", () => {
    const result = stableTools([tool("agent_run", "dynamic agent list: foo bar")]);
    expect(result[0].description).not.toContain("foo");
    expect(result[0].description).toContain("委托专用子 agent");
  });

  it("builds dynamic agent registry as attachment text", () => {
    const text = buildAgentRegistryAttachment([
      { name: "b", description: "B", systemPrompt: "", tools: ["web_search"], maxIterations: 2 },
      { name: "a", description: "A", systemPrompt: "", tools: ["bash"] },
    ]);
    expect(text).toContain("<agent_registry>");
    expect(text.indexOf("a：A")).toBeLessThan(text.indexOf("b：B"));
  });
});
