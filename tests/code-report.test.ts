import { describe, it, expect } from "vitest";
import { formatCodeChangeReport } from "../workflows/code-report.js";

describe("code change report", () => {
  it("formats changed files, validations, risks and rollback", () => {
    const report = formatCodeChangeReport({
      summary: "优化 trace 存储",
      changedFiles: ["infra/trace.ts", "tests/trace.test.ts"],
      validations: ["npm test passed"],
      risks: ["旧 trace 数据兼容性"],
      rollback: "git revert HEAD",
    });
    expect(report).toContain("优化 trace 存储");
    expect(report).toContain("infra/trace.ts");
    expect(report).toContain("git revert HEAD");
  });
});
