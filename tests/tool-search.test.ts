import { describe, it, expect } from "vitest";
import { selectCoreTools, buildToolSearchIndex } from "../tools/tool-search.js";

const names = ["bash", "read_file", "web_search", "browser_navigate", "mcp_big_tool", "memory_save"];

describe("tool search / deferred loading", () => {
  it("keeps only core tools in the initial prompt", () => {
    expect(selectCoreTools(names)).toEqual(["bash", "read_file", "web_search"]);
  });

  it("builds a searchable deferred tool index", () => {
    const index = buildToolSearchIndex(names, ["bash", "read_file", "web_search"]);
    expect(index.search("browser")).toEqual(["browser_navigate"]);
    expect(index.search("memory")).toEqual(["memory_save"]);
  });
});
