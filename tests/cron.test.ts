import { describe, it, expect } from "vitest";
import { cronMatches, nextRun } from "../infra/cron.js";

// ── cronMatches ───────────────────────────────────────────────────────────────

describe("cronMatches", () => {
  const d = (h: number, m: number, dom = 15, mon = 6, dow = 3) =>
    new Date(2026, mon - 1, dom, h, m, 0, 0); // month is 0-indexed

  it("* * * * * matches any time", () => {
    expect(cronMatches("* * * * *", d(9, 0))).toBe(true);
    expect(cronMatches("* * * * *", d(23, 59))).toBe(true);
  });

  it("exact minute and hour", () => {
    expect(cronMatches("0 9 * * *", d(9, 0))).toBe(true);
    expect(cronMatches("0 9 * * *", d(9, 1))).toBe(false);
    expect(cronMatches("0 9 * * *", d(10, 0))).toBe(false);
  });

  it("step: */5 matches multiples of 5", () => {
    expect(cronMatches("*/5 * * * *", d(9, 0))).toBe(true);
    expect(cronMatches("*/5 * * * *", d(9, 5))).toBe(true);
    expect(cronMatches("*/5 * * * *", d(9, 30))).toBe(true);
    expect(cronMatches("*/5 * * * *", d(9, 1))).toBe(false);
    expect(cronMatches("*/5 * * * *", d(9, 7))).toBe(false);
  });

  it("range: 9-17 matches within range", () => {
    expect(cronMatches("0 9-17 * * *", d(9, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", d(17, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", d(8, 0))).toBe(false);
    expect(cronMatches("0 9-17 * * *", d(18, 0))).toBe(false);
  });

  it("list: 1,3,5 matches listed values", () => {
    expect(cronMatches("0 0 * * 1,3,5", new Date(2026, 5, 15, 0, 0))).toBe(true); // Mon
    expect(cronMatches("0 0 * * 1,3,5", new Date(2026, 5, 17, 0, 0))).toBe(true); // Wed
    expect(cronMatches("0 0 * * 1,3,5", new Date(2026, 5, 16, 0, 0))).toBe(false); // Tue
  });

  it("day-of-month and month", () => {
    expect(cronMatches("0 0 1 1 *", new Date(2026, 0, 1, 0, 0))).toBe(true);
    expect(cronMatches("0 0 1 1 *", new Date(2026, 0, 2, 0, 0))).toBe(false);
    expect(cronMatches("0 0 1 1 *", new Date(2026, 1, 1, 0, 0))).toBe(false);
  });

  it("rejects wrong field count", () => {
    expect(cronMatches("0 9 * *", d(9, 0))).toBe(false);
    expect(cronMatches("0 9 * * * *", d(9, 0))).toBe(false);
    expect(cronMatches("", d(9, 0))).toBe(false);
  });

  it("step with range: 0-30/10", () => {
    expect(cronMatches("0-30/10 * * * *", d(9, 0))).toBe(true);
    expect(cronMatches("0-30/10 * * * *", d(9, 10))).toBe(true);
    expect(cronMatches("0-30/10 * * * *", d(9, 20))).toBe(true);
    expect(cronMatches("0-30/10 * * * *", d(9, 30))).toBe(true);
    expect(cronMatches("0-30/10 * * * *", d(9, 5))).toBe(false);
    expect(cronMatches("0-30/10 * * * *", d(9, 40))).toBe(false);
  });
});

// ── nextRun ───────────────────────────────────────────────────────────────────

describe("nextRun", () => {
  it("returns next matching minute", () => {
    const from = new Date(2026, 5, 15, 9, 0, 0); // 09:00
    const next = nextRun("30 9 * * *", from);
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });

  it("skips current minute, starts from +1", () => {
    const from = new Date(2026, 5, 15, 9, 0, 0); // exactly 09:00
    const next = nextRun("0 9 * * *", from);
    const d = new Date(next);
    // Should be next day at 09:00, not same minute
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("crosses midnight correctly", () => {
    const from = new Date(2026, 5, 15, 23, 50, 0);
    const next = nextRun("0 0 * * *", from);
    const d = new Date(next);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("returns -1 for unmatchable expression", () => {
    const from = new Date(2026, 5, 15, 9, 0, 0);
    // Feb 30 doesn't exist
    expect(nextRun("0 0 30 2 *", from)).toBe(-1);
  });

  it("every 5 minutes: next is within 5 minutes", () => {
    const from = new Date(2026, 5, 15, 9, 3, 0);
    const next = nextRun("*/5 * * * *", from);
    const d = new Date(next);
    expect(d.getMinutes()).toBe(5);
    expect(next - from.getTime()).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
