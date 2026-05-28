import { describe, it, expect } from "vitest";
import { buildToolLoadRequest, toolSearchToolSchema } from "../tools/tool-search.js";

describe("tool loading", () => {
  it("defines a stable tool_search schema", () => {
    expect(toolSearchToolSchema.name).toBe("tool_search");
    expect(toolSearchToolSchema.description).not.toContain("browser_navigate");
  });

  it("builds a deterministic tool load request from search results", () => {
    const request = buildToolLoadRequest("browser", ["browser_type", "browser_navigate", "browser_click"], 2);
    expect(request.query).toBe("browser");
    expect(request.tools).toEqual(["browser_click", "browser_navigate"]);
  });
});
