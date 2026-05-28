import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export function handlePageRequest(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  if (url === "/trace" || url.startsWith("/trace?") || url === "/trace-page" || url.startsWith("/trace-page?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "trace.html")));
    return true;
  }

  if (url === "/settings" || url === "/settings-page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "settings.html")));
    return true;
  }

  if (url === "/mcp" || url === "/mcp-page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "mcp.html")));
    return true;
  }

  if (url === "/monitor" || url === "/monitor-page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "monitor.html")));
    return true;
  }

  if (url === "/agents" || url === "/agents-page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "agents.html")));
    return true;
  }

  if (url === "/skills" || url === "/skills-page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "skills.html")));
    return true;
  }

  if (url === "/chat") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(ROOT, "index.html")));
    return true;
  }

  return false;
}
