import { describe, it, expect } from "vitest";
import { selectWorkflowForTask } from "../workflows/selector.js";

describe("workflow task selector", () => {
  it("selects research for investigation tasks", () => {
    const result = selectWorkflowForTask("调研一下当前热门 agent workflow 趋势");
    expect(result.mode).toBe("workflow");
    if (result.mode === "workflow") expect(result.kind).toBe("research");
  });

  it("selects code for code change tasks", () => {
    const result = selectWorkflowForTask("修复这个 bug 并运行测试");
    expect(result.mode).toBe("workflow");
    if (result.mode === "workflow") expect(result.kind).toBe("code");
  });

  it("selects kb for knowledge ingestion tasks", () => {
    const result = selectWorkflowForTask("把这些客服问答整理成知识库并标注风险");
    expect(result.mode).toBe("workflow");
    if (result.mode === "workflow") expect(result.kind).toBe("kb");
  });

  it("selects brainstorm-council template for ideation tasks", () => {
    const result = selectWorkflowForTask("找几个不同角色来脑暴一个产品方向");
    expect(result.mode).toBe("workflow");
    if (result.mode === "workflow") expect(result.templateId).toBe("brainstorm-council");
  });

  it("keeps simple requests direct", () => {
    const result = selectWorkflowForTask("你好");
    expect(result.mode).toBe("direct");
  });
});
