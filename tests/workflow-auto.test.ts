import { describe, it, expect, afterEach } from "vitest";
import { selectWorkflowForTask } from "../workflows/selector.js";
import { shouldAutoHandleWorkflow } from "../domain/workflow-auto.js";

describe("main loop auto workflow guardrail", () => {
  const original = process.env.WORKFLOW_AUTO_MAIN_LOOP;

  afterEach(() => {
    if (original === undefined) delete process.env.WORKFLOW_AUTO_MAIN_LOOP;
    else process.env.WORKFLOW_AUTO_MAIN_LOOP = original;
  });

  it("auto-handles research, kb and self-contained task templates", () => {
    expect(shouldAutoHandleWorkflow("调研一下热门 agent workflow", selectWorkflowForTask("调研一下热门 agent workflow"))).toBe(true);
    expect(shouldAutoHandleWorkflow("把客服问答整理成知识库", selectWorkflowForTask("把客服问答整理成知识库"))).toBe(true);
    const selection = selectWorkflowForTask("找几个不同角色脑暴一个产品方向");
    expect(shouldAutoHandleWorkflow("找几个不同角色脑暴一个产品方向", selection)).toBe(true);
  });

  it("does not intercept code tasks in the main loop because patch authoring remains in the agent tool loop", () => {
    expect(shouldAutoHandleWorkflow("修复这个 bug 并运行测试", selectWorkflowForTask("修复这个 bug 并运行测试"))).toBe(false);
  });

  it("does not handle slash commands or disabled auto mode", () => {
    const selection = selectWorkflowForTask("找几个不同角色脑暴一个产品方向");
    expect(shouldAutoHandleWorkflow("/workflow auto 找几个不同角色脑暴一个产品方向", selection)).toBe(false);
    process.env.WORKFLOW_AUTO_MAIN_LOOP = "0";
    expect(shouldAutoHandleWorkflow("找几个不同角色脑暴一个产品方向", selection)).toBe(false);
  });
});
