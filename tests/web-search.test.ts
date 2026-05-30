import { afterEach, describe, expect, it, vi } from "vitest";
import { toolWebSearch } from "../tools/web.js";

const originalFetch = globalThis.fetch;
const originalAnySearchKey = process.env.ANY_SEARCH_KEY;
const originalAnysearchApiKey = process.env.ANYSEARCH_API_KEY;
const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;

describe("toolWebSearch AnySearch provider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.ANY_SEARCH_KEY = originalAnySearchKey;
    process.env.ANYSEARCH_API_KEY = originalAnysearchApiKey;
    process.env.TAVILY_API_KEY = originalTavilyKey;
    process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
    vi.restoreAllMocks();
  });

  it("uses AnySearch when ANY_SEARCH_KEY is configured", async () => {
    process.env.ANY_SEARCH_KEY = "test-anysearch-key";
    delete process.env.ANYSEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;

    // AnySearch wraps the payload: { code, message, data: { results, metadata } }.
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      message: "success",
      data: {
        results: [
          {
            title: "Example result",
            url: "https://example.com/result",
            description: "",
            content: "full content body",
            score: 82.3,
            quality_score: 82.3,
            signal_scores: { relevance: 0.8 },
          },
        ],
        metadata: { total_results: 1, request_id: "req_test" },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const output = await toolWebSearch({ query: "hello", max_results: 3 });
    const parsed = JSON.parse(output);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.anysearch.com/v1/search");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-anysearch-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: "hello", max_results: 3 });
    expect(parsed.provider).toBe("anysearch");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({
      title: "Example result",
      url: "https://example.com/result",
      snippet: "full content body",
      content: "full content body",
      quality_score: 82.3,
    });
    expect(parsed.metadata).toMatchObject({ total_results: 1, request_id: "req_test" });
  });

  it("falls through to the next provider when AnySearch returns an error envelope", async () => {
    process.env.ANY_SEARCH_KEY = "test-anysearch-key";
    delete process.env.ANYSEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("anysearch")) {
        return new Response(JSON.stringify({ code: 1, message: "quota exceeded" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // DuckDuckGo fallback (no other key set).
      return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const output = await toolWebSearch({ query: "hello", max_results: 3 });
    const parsed = JSON.parse(output);

    expect(parsed.provider).toBe("duckduckgo");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("anysearch"))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("duckduckgo"))).toBe(true);
  });
});
