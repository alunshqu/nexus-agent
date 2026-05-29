import { describe, it, expect, vi, afterEach } from "vitest";
import { isRetryableError, parseRetryAfter, computeRetryDelay } from "../infra/provider.js";

describe("isRetryableError", () => {
  it("retries on 429 and all 5xx (flaky upstream channel)", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ status: 504 })).toBe(true);
    expect(isRetryableError({ statusCode: 529 })).toBe(true);
  });

  it("does NOT retry on 4xx client errors (except 429)", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 422 })).toBe(false);
  });

  it("retries on Anthropic structured error types", () => {
    expect(isRetryableError({ type: "rate_limit_error" })).toBe(true);
    expect(isRetryableError({ type: "overloaded_error" })).toBe(true);
    expect(isRetryableError({ type: "api_error" })).toBe(true);
    expect(isRetryableError({ error: { type: "upstream_error" } })).toBe(true);
  });

  it("retries on transient network error codes", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
      expect(isRetryableError({ code })).toBe(true);
    }
    expect(isRetryableError({ cause: { code: "ECONNREFUSED" } })).toBe(true);
  });

  it("falls back to message matching when no structured fields", () => {
    expect(isRetryableError({ message: "Upstream request failed" })).toBe(true);
    expect(isRetryableError({ message: "Concurrency limit exceeded" })).toBe(true);
    expect(isRetryableError({ message: "service temporarily unavailable" })).toBe(true);
    expect(isRetryableError({ message: "Responses API error 503: bad gateway" })).toBe(true);
  });

  it("does NOT retry an ordinary error with no retryable signal", () => {
    expect(isRetryableError({ message: "invalid request: bad tool schema" })).toBe(false);
    expect(isRetryableError(new Error("something else"))).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds into ms", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses HTTP-date into ms from now", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future)!;
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("clamps past dates to 0", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("returns undefined for missing/garbage values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});

describe("computeRetryDelay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies full jitter within [0, exp] and grows exponentially", () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // upper bound of jitter
    expect(computeRetryDelay(0)).toBe(1000);  // base * 2^0
    expect(computeRetryDelay(1)).toBe(2000);  // base * 2^1
    expect(computeRetryDelay(2)).toBe(4000);  // base * 2^2
  });

  it("jitter floors toward 0 (thundering-herd spread)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(computeRetryDelay(3)).toBe(0);
  });

  it("caps the exponential term at the max delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    // attempt 20 would be astronomically large without the cap.
    expect(computeRetryDelay(20)).toBe(30_000);
  });

  it("never waits less than Retry-After when the server provides it", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // jitter would be 0
    expect(computeRetryDelay(0, 5000)).toBe(5000);
  });
});
