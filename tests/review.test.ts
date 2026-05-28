import { describe, it, expect } from "vitest";
import { buildReviewChecklist, evaluateReviewChecklist } from "../workflows/review.js";

describe("review checklist", () => {
  it("builds checklist for code changes", () => {
    const checklist = buildReviewChecklist("code_change");
    expect(checklist.items.map(i => i.id)).toEqual(expect.arrayContaining(["tests_passed", "diff_reviewed", "rollback_defined"]));
  });

  it("evaluates checklist completion", () => {
    const checklist = buildReviewChecklist("research");
    const result = evaluateReviewChecklist(checklist, { sources_verified: true, uncertainty_stated: false });
    expect(result.passed).toBe(false);
    expect(result.missing.map(i => i.id)).toContain("uncertainty_stated");
  });
});
