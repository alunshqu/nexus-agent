import { describe, it, expect } from "vitest";
import { buildActiveTools } from "../tools/tool-assembly.js";

const tool = (name: string) => ({
  name,
  description: name,
  input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
});

describe("active tool assembly", () => {
  const all = [tool("bash"), tool("read_file"), tool("browser_navigate"), tool("memory_save")];

  it("includes only core tools and tool_search by default", () => {
    const active = buildActiveTools(all, { deferredLoading: true, loadedTools: [] });
    expect(active.map(t => t.name)).toEqual(["bash", "read_file", "tool_search"]);
  });

  it("includes explicitly loaded deferred tools", () => {
    const active = buildActiveTools(all, { deferredLoading: true, loadedTools: ["browser_navigate"] });
    expect(active.map(t => t.name)).toEqual(["bash", "browser_navigate", "read_file", "tool_search"]);
  });
});
