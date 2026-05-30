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

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      results: [
        {
          title: "Example result",
          url: "https://example.com/result",
          description: "short description",
          content: "full content",
          source: "web",
          score: 0.8,
          quality_score: 0.9,
          published_at: "2026-05-29T00:00:00Z",
        },
      ],
      metadata: { total_results: 1, request_id: "req_test" },
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
    expect(parsed.results[0]).toMatchObject({
      title: "Example result",
      url: "https://example.com/result",
      quality_score: 0.9,
    });
  });
});
