import dns from "node:dns";
import { promises as dnsp } from "node:dns";
import { readFileSync } from "node:fs";
import { createLogger } from "./logger.js";

const logger = createLogger("dns-fix");

// Public fallbacks used only if /etc/resolv.conf yields nothing usable.
const FALLBACK_SERVERS = ["223.5.5.5", "119.29.29.29", "8.8.8.8"];

function readResolvConf(): string[] {
  try {
    return readFileSync("/etc/resolv.conf", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("nameserver"))
      .map((l) => l.split(/\s+/)[1])
      .filter((ip) => ip && ip !== "127.0.0.1" && ip !== "::1");
  } catch {
    return [];
  }
}

// dns.lookup (what fetch/undici, net, http all use by default) goes through the OS
// getaddrinfo path, which ignores dns.setServers and is the broken one on this host.
// dns.resolve4/6 DO honor setServers. So we monkey-patch dns.lookup to delegate to
// dns.resolve*, redirecting every consumer onto the working path with no per-call wiring.
function installResolveBasedLookup(): void {
  const originalLookup = dns.lookup.bind(dns);

  const patched: any = (hostname: string, options: any, callback?: any) => {
    if (typeof options === "function") { callback = options; options = {}; }
    options = options || {};
    const cb = callback as (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

    // Literal IPs / localhost must not hit the resolver — defer to the original.
    if (!hostname || hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
      return originalLookup(hostname, options, cb);
    }

    const wantAll = options.all === true;
    dnsp.resolve4(hostname)
      .then((addrs) => {
        if (!addrs.length) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        if (wantAll) cb(null, addrs.map((address) => ({ address, family: 4 })) as any);
        else cb(null, addrs[0] as any, 4);
      })
      // If resolve fails, fall back to the original lookup rather than hard-failing.
      .catch(() => originalLookup(hostname, options, cb));
  };
  patched.__resolveBasedPatched = true;
  (dns as any).lookup = patched;
}

// Work around a Node runtime falling back to 127.0.0.1 as its DNS server when the system
// resolver config is unreadable at startup (observed on this host: scutil --dns empty,
// nothing listening on 127.0.0.1:53, so every getaddrinfo => ENOTFOUND while the browser
// and nslookup still resolve fine). Two parts:
//   1. Repoint dns.setServers() at the real resolvers (fixes dns.resolve*).
//   2. Monkey-patch dns.lookup to delegate to dns.resolve* — because fetch uses dns.lookup
//      (OS getaddrinfo), which ignores setServers, so step 1 alone does NOT fix fetch.
// We only engage when Node is actually pointed at loopback with no local resolver;
// otherwise the system path works and we leave everything untouched.
export function ensureUsableDnsServers(): void {
  const current = dns.getServers();
  const onlyLoopback = current.length === 0 || current.every((s) => s === "127.0.0.1" || s === "::1");
  if (!onlyLoopback) {
    logger.info("dns_servers_ok", { servers: current });
    return;
  }

  const fromResolv = readResolvConf();
  const servers = fromResolv.length > 0 ? fromResolv : FALLBACK_SERVERS;
  try {
    dns.setServers(servers);
    installResolveBasedLookup();
    logger.warn("dns_servers_overridden", { was: current, now: dns.getServers(), source: fromResolv.length > 0 ? "resolv.conf" : "fallback", fetchLookup: "resolve-based" });
  } catch (error) {
    logger.error("dns_set_servers_failed", error, { attempted: servers });
  }
}
