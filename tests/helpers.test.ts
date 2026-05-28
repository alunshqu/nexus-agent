import { describe, it, expect } from "vitest";
import {
  truncate, keepTail, clampNumber, expectString, asRecord,
  globToRegExp, decodeDuckDuckGoUrl, stripHtml, decodeHtml,
  countOccurrences,
} from "../tools/helpers.js";

describe("truncate", () => {
  it("returns value unchanged when under limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates and appends truncation notice", () => {
    const result = truncate("abcdefghij", 5);
    expect(result).toContain("truncated");
    expect(result.startsWith("abcde")).toBe(true);
  });

  it("exact limit passes through", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });
});

describe("keepTail", () => {
  it("returns full string when under limit", () => {
    expect(keepTail("hello", 10)).toBe("hello");
  });

  it("keeps only the tail when over limit", () => {
    expect(keepTail("abcdefgh", 4)).toBe("efgh");
  });

  it("exact limit returns full string", () => {
    expect(keepTail("abcd", 4)).toBe("abcd");
  });
});

describe("clampNumber", () => {
  it("returns value within range", () => {
    expect(clampNumber(5, 10, 1, 100)).toBe(5);
  });

  it("clamps to min", () => {
    expect(clampNumber(0, 10, 1, 100)).toBe(1);
  });

  it("clamps to max", () => {
    expect(clampNumber(200, 10, 1, 100)).toBe(100);
  });

  it("returns fallback for non-finite", () => {
    expect(clampNumber(NaN, 42, 1, 100)).toBe(42);
    expect(clampNumber(Infinity, 42, 1, 100)).toBe(42); // Infinity is not finite → fallback
    expect(clampNumber("abc", 42, 1, 100)).toBe(42);
  });

  it("floors decimal values", () => {
    expect(clampNumber(5.9, 10, 1, 100)).toBe(5);
  });
});

describe("expectString", () => {
  it("returns string value", () => {
    expect(expectString("hello", "name")).toBe("hello");
  });

  it("throws for non-string", () => {
    expect(() => expectString(42, "name")).toThrow("name must be a string");
    expect(() => expectString(null, "name")).toThrow("name must be a string");
    expect(() => expectString(undefined, "name")).toThrow("name must be a string");
  });
});

describe("asRecord", () => {
  it("returns plain object as-is", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns empty object for non-objects", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord(42)).toEqual({});
    expect(asRecord("str")).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
  });
});

describe("globToRegExp", () => {
  it("* matches within a directory segment", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.js")).toBe(false);
    expect(re.test("dir/foo.ts")).toBe(false); // * doesn't cross /
  });

  it("** matches across directories", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/deep/foo.ts")).toBe(true);
    expect(re.test("src/foo.js")).toBe(false);
  });

  it("? matches single non-slash character", () => {
    const re = globToRegExp("fo?.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("fo.ts")).toBe(false);
    expect(re.test("fooo.ts")).toBe(false);
  });

  it("exact match", () => {
    const re = globToRegExp("README.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("readme.md")).toBe(false);
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("abcabc", "abc")).toBe(2);
    expect(countOccurrences("aaa", "aa")).toBe(1);
  });

  it("returns 0 when not found", () => {
    expect(countOccurrences("hello", "xyz")).toBe(0);
  });

  it("throws for empty needle", () => {
    expect(() => countOccurrences("hello", "")).toThrow();
  });
});

describe("decodeDuckDuckGoUrl", () => {
  it("extracts uddg param", () => {
    const url = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com";
    expect(decodeDuckDuckGoUrl(url)).toBe("https://example.com");
  });

  it("returns href when no uddg param (relative url resolved against duckduckgo.com)", () => {
    // new URL("not-a-url", "https://duckduckgo.com") resolves to https://duckduckgo.com/not-a-url
    const url = "https://example.com/page";
    expect(decodeDuckDuckGoUrl(url)).toBe(url);
  });
});

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes HTML entities", () => {
    expect(stripHtml("&lt;div&gt;")).toBe("<div>");
    expect(stripHtml("&amp;")).toBe("&");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("a   b")).toBe("a b");
  });
});

describe("decodeHtml", () => {
  it("decodes all standard entities", () => {
    expect(decodeHtml("&amp;&quot;&#39;&lt;&gt;")).toBe(`&"'<>`);
  });

  it("leaves non-entity text unchanged", () => {
    expect(decodeHtml("hello world")).toBe("hello world");
  });
});

describe("allowedTools wildcard matching", () => {
  // Mirrors the logic in domain/agent.ts
  function filterTools(toolNames: string[], allowedTools: string[]): string[] {
    return toolNames.filter(name =>
      allowedTools.some(pattern =>
        pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern
      )
    );
  }

  it("exact match", () => {
    expect(filterTools(["web_search", "web_fetch", "bash"], ["web_search"])).toEqual(["web_search"]);
  });

  it("wildcard match with *", () => {
    expect(filterTools(["browser_navigate", "browser_screenshot", "bash"], ["browser_*"])).toEqual(["browser_navigate", "browser_screenshot"]);
  });

  it("mixed exact and wildcard", () => {
    const tools = ["web_search", "web_fetch", "browser_navigate", "browser_screenshot", "bash", "read_file"];
    const allowed = ["web_search", "web_fetch", "browser_*"];
    expect(filterTools(tools, allowed)).toEqual(["web_search", "web_fetch", "browser_navigate", "browser_screenshot"]);
  });

  it("no match returns empty", () => {
    expect(filterTools(["bash", "read_file"], ["web_*"])).toEqual([]);
  });

  it("* alone matches everything", () => {
    expect(filterTools(["bash", "web_search"], ["*"])).toEqual(["bash", "web_search"]);
  });
});
