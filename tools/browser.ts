import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import type { SessionState } from "../domain/types.js";
import { createLogger } from "../infra/logger.js";
import { timing } from "../infra/metrics.js";

const SCREENSHOT_DIR = path.join(os.homedir(), ".agent", "screenshots");

const logger = createLogger("browser_tool");

// Lazy-loaded CDP client
let CDP: any;
async function getCDP() {
  if (!CDP) CDP = (await import("chrome-remote-interface")).default;
  return CDP;
}

const CHROME_PATH = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);

let chromeProcess: ReturnType<typeof spawn> | null = null;

async function ensureChrome() {
  // Check if Chrome is already listening
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (res.ok) return;
  } catch (error) {
    logger.debug("chrome_probe_failed", { port: CDP_PORT, error: error instanceof Error ? error.message : String(error) });
  }

  // Launch Chrome with remote debugging
  chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=/tmp/agent-chrome-profile",
  ], { stdio: "ignore", detached: true });
  chromeProcess.unref();

  // Wait for Chrome to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return;
    } catch (error) {
      logger.debug("chrome_wait_probe_failed", { port: CDP_PORT, attempt: i + 1, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new Error("Chrome did not start in time");
}

async function withPage<T>(tabId: string | undefined, fn: (client: any) => Promise<T>): Promise<T> {
  const cdp = await getCDP();
  const connectStart = Date.now();
  const client = await cdp({ port: CDP_PORT, target: tabId });
  timing("browser.cdp_connect_ms", Date.now() - connectStart);
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    await client.DOM.enable();
    return await fn(client);
  } finally {
    await client.close();
  }
}

export const browserTools: Anthropic.Tool[] = [
  {
    name: "browser_navigate",
    description: "Navigate to a URL in Chrome. Launches Chrome with remote debugging if not running.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to." },
        tab_id: { type: "string", description: "Optional CDP target ID. Uses first tab if omitted." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page. Saves to a local file and returns the file path. Use send_media to send the image to the user.",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        filename: { type: "string", description: "Optional filename (without extension). Defaults to timestamp-based name." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_get_content",
    description: "Get the text content and title of the current page.",
    input_schema: {
      type: "object",
      properties: {
        tab_id: { type: "string" },
        selector: { type: "string", description: "Optional CSS selector to get content from a specific element." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click." },
        tab_id: { type: "string" },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "Type text into an input element.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the input element." },
        text: { type: "string", description: "Text to type." },
        clear_first: { type: "boolean", description: "Clear existing value before typing." },
        tab_id: { type: "string" },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_eval",
    description: "Execute JavaScript in the page context and return the result.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate." },
        tab_id: { type: "string" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs",
    description: "List all open Chrome tabs with their IDs, URLs, and titles.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_new_tab",
    description: "Open a new tab and optionally navigate to a URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

export async function executeBrowserTool(
  _state: SessionState,
  name: string,
  rawInput: unknown
): Promise<{ content: string; is_error?: boolean }> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, any>;

  try {
    await ensureChrome();

    switch (name) {
      case "browser_tabs": {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const tabs = await res.json() as any[];
        const pages = tabs.filter((t) => t.type === "page");
        return { content: JSON.stringify(pages.map((t) => ({ id: t.id, url: t.url, title: t.title })), null, 2) };
      }

      case "browser_new_tab": {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(input.url ?? "about:blank")}`, { method: "PUT" });
        const tab = await res.json() as any;
        return { content: JSON.stringify({ id: tab.id, url: tab.url }) };
      }

      case "browser_navigate": {
        const tabId = input.tab_id ?? await getFirstTabId();
        return withPage(tabId, async (client) => {
          await client.Page.navigate({ url: input.url });
          await client.Page.loadEventFired();
          const { result } = await client.Runtime.evaluate({ expression: "document.title" });
          return { content: `Navigated to ${input.url} — title: ${result.value}` };
        });
      }

      case "browser_screenshot": {
        const tabId = input.tab_id ?? await getFirstTabId();
        return withPage(tabId, async (client) => {
          const { data } = await client.Page.captureScreenshot({ format: "png" });
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const fname = input.filename
            ? `${String(input.filename)}.png`
            : `screenshot_${Date.now()}.png`;
          const filePath = path.join(SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, "base64"));
          return { content: JSON.stringify({ filePath, size: data.length * 3 / 4 | 0 }) };
        });
      }

      case "browser_get_content": {
        const tabId = input.tab_id ?? await getFirstTabId();
        return withPage(tabId, async (client) => {
          const expr = input.selector
            ? `document.querySelector(${JSON.stringify(input.selector)})?.innerText ?? "not found"`
            : `JSON.stringify({ title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 8000) })`;
          const { result } = await client.Runtime.evaluate({ expression: expr });
          return { content: String(result.value ?? result.description ?? "") };
        });
      }

      case "browser_click": {
        const tabId = input.tab_id ?? await getFirstTabId();
        return withPage(tabId, async (client) => {
          const { result } = await client.Runtime.evaluate({
            expression: `
              const el = document.querySelector(${JSON.stringify(input.selector)});
              if (!el) throw new Error("Element not found: ${input.selector}");
              el.scrollIntoView({ block: "center" });
              const rect = el.getBoundingClientRect();
              JSON.stringify({ x: rect.left + rect.width/2, y: rect.top + rect.height/2, text: el.innerText?.slice(0,100) })
            `,
          });
          const { x, y, text } = JSON.parse(result.value);
          await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          return { content: `Clicked "${text}" at (${Math.round(x)}, ${Math.round(y)})` };
        });
      }

      case "browser_type": {
        const tabId = input.tab_id ?? await getFirstTabId();
        return withPage(tabId, async (client) => {
          if (input.clear_first) {
            await client.Runtime.evaluate({
              expression: `const el = document.querySelector(${JSON.stringify(input.selector)}); if (el) { el.focus(); el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); }`,
            });
          }
          await client.Runtime.evaluate({
            expression: `document.querySelector(${JSON.stringify(input.selector)})?.focus()`,
          });
          const text = String(input.text);
          await client.Runtime.evaluate({
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(input.selector)});
              if (!el) throw new Error("Element not found: ${input.selector}");
              const value = ${JSON.stringify(text)};
              if (typeof el.value === 'string') {
                el.value = (el.value || '') + value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                el.textContent = (el.textContent || '') + value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              return true;
            })()`,
            returnByValue: true,
          });
          return { content: `Typed "${input.text}" into ${input.selector}` };
        });
      }

      case "browser_eval": {
        const tabId = input.tab_id ?? await getFirstTabId();
        return withPage(tabId, async (client) => {
          const { result, exceptionDetails } = await client.Runtime.evaluate({
            expression: input.expression,
            returnByValue: true,
          });
          if (exceptionDetails) throw new Error(exceptionDetails.text ?? "JS error");
          const raw = JSON.stringify(result.value ?? result.description, null, 2);
          return { content: raw.length > 10000 ? raw.slice(0, 10000) + `\n... [${raw.length - 10000} chars truncated]` : raw };
        });
      }

      default:
        return { content: `Unknown browser tool: ${name}`, is_error: true };
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), is_error: true };
  }
}

async function getFirstTabId(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const tabs = await res.json() as any[];
  const page = tabs.find((t) => t.type === "page");
  if (!page) throw new Error("No open tabs found");
  return page.id;
}
