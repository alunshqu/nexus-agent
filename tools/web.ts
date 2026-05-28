import type Anthropic from "@anthropic-ai/sdk";
import { expectString, clampNumber, truncate, isPlainObject, decodeDuckDuckGoUrl, stripHtml, decodeHtml } from "./helpers.js";

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
    description: "Search the web. Uses Brave Search if BRAVE_SEARCH_API_KEY is set, otherwise DuckDuckGo.",
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
  const response = await fetch(url, { method, headers, body, redirect: "follow" });
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

  if (process.env.TAVILY_API_KEY) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    const json = await response.json() as any;
    const results = (json.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 300) }));
    return truncate(JSON.stringify({ provider: "tavily", query, answer: json.answer, results }, null, 2));
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    const response = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY } });
    const json = await response.json() as any;
    return truncate(JSON.stringify({ provider: "brave", query, results: json.web?.results ?? json }, null, 2));
  }

  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await response.text();
  const results = parseDuckDuckGoResults(html).slice(0, maxResults);
  return truncate(JSON.stringify({ provider: "duckduckgo", query, results }, null, 2));
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
