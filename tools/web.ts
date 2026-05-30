import type Anthropic from "@anthropic-ai/sdk";
import { expectString, clampNumber, truncate, isPlainObject, decodeDuckDuckGoUrl, stripHtml, decodeHtml } from "./helpers.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("web_tool");

const WEB_FETCH_TIMEOUT_MS = Number(process.env.WEB_FETCH_TIMEOUT_MS ?? 30000);
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? 30000);

export const webTools: Anthropic.Tool[] = [
  {
    name: "web_fetch",
    description: "Fetch a URL. Supports GET/POST/PUT/PATCH/DELETE.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description: "Search the web. Uses AnySearch if ANY_SEARCH_KEY or ANYSEARCH_API_KEY is set, then Tavily, Brave Search, otherwise DuckDuckGo.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export async function toolWebFetch(input: Record<string, unknown>) {
  const url = expectString(input.url, "url");
  const method = String(input.method ?? "GET").toUpperCase();
  const headers = isPlainObject(input.headers) ? Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k, String(v)])) : undefined;
  const body = input.body == null ? undefined : expectString(input.body, "body");
  const response = await fetchWithTimeout(url, { method, headers, body, redirect: "follow" }, WEB_FETCH_TIMEOUT_MS, "web_fetch");
  const contentType = response.headers.get("content-type") ?? "";
  let text = await response.text();

  // Strip HTML to plain text — raw HTML is useless to the model and wastes tokens
  if (contentType.includes("text/html")) {
    text = stripHtml(text).slice(0, 20000);
  } else {
    text = text.slice(0, 20000);
  }

  return truncate(JSON.stringify({ url: response.url, status: response.status, body: text }, null, 2));
}

export async function toolWebSearch(input: Record<string, unknown>) {
  const query = expectString(input.query, "query");
  const maxResults = clampNumber(input.max_results, 8, 1, 20);

  const anySearchKey = process.env.ANY_SEARCH_KEY ?? process.env.ANYSEARCH_API_KEY;
  if (anySearchKey) {
    try {
      const response = await fetchWithTimeout("https://api.anysearch.com/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${anySearchKey}` },
        body: JSON.stringify({ query, max_results: maxResults }),
      }, WEB_SEARCH_TIMEOUT_MS, "web_search:anysearch");
      const json = await response.json() as any;
      if (!response.ok || json.code !== 0) {
        throw new Error(`anysearch ${response.status}: ${json.message ?? "unknown error"}`);
      }
      // AnySearch wraps the payload: { code, message, data: { results, metadata } }.
      const results = (json.data?.results ?? []).map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: String(r.description || r.content || "").slice(0, 500),
        content: r.content ? String(r.content).slice(0, 2000) : undefined,
        score: r.score,
        quality_score: r.quality_score,
      }));
      return truncate(JSON.stringify({ provider: "anysearch", query, results, metadata: json.data?.metadata }, null, 2));
    } catch (error) {
      // Fall through to the next provider, but surface why AnySearch failed.
      logger.warn("anysearch_failed", { query, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (process.env.TAVILY_API_KEY) {
    const response = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: maxResults }),
    }, WEB_SEARCH_TIMEOUT_MS, "web_search:tavily");
    const json = await response.json() as any;
    const results = (json.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 300) }));
    return truncate(JSON.stringify({ provider: "tavily", query, answer: json.answer, results }, null, 2));
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    const response = await fetchWithTimeout(url, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY } }, WEB_SEARCH_TIMEOUT_MS, "web_search:brave");
    const json = await response.json() as any;
    return truncate(JSON.stringify({ provider: "brave", query, results: json.web?.results ?? json }, null, 2));
  }

  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, WEB_SEARCH_TIMEOUT_MS, "web_search:duckduckgo");
  const html = await response.text();
  const results = parseDuckDuckGoResults(html).slice(0, maxResults);
  return truncate(JSON.stringify({ provider: "duckduckgo", query, results }, null, 2));
}

async function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const target = typeof url === "string" ? url : url.href;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms: ${target}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoResults(html: string) {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  const blocks = html.split(/<div class="result[\s"]|<div class="web-result/).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ?? block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const rawUrl = decodeHtml(linkMatch[1]);
    const resultUrl = decodeDuckDuckGoUrl(rawUrl);
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ?? block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : undefined;
    if (title && resultUrl && !results.some((r) => r.url === resultUrl)) results.push({ title, url: resultUrl, snippet });
  }
  return results;
}
