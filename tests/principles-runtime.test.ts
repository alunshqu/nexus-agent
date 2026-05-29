import { describe, it, expect } from "vitest";
import { selectPrinciplesForTask, classifyTask } from "../principles/selector.js";
import { renderActivePrinciplesForPrompt } from "../principles/prompt.js";
import { createEmptyPrincipleEvidence, evaluatePrinciples, recordToolEvidence } from "../principles/evaluator.js";

describe("principle runtime", () => {
  it("actively selects source-fix principles for bug/runtime tasks without explicit source-fix wording", () => {
    const selected = selectPrinciplesForTask("这个调用咋回事，老是 cancle");
    const ids = selected.map(p => p.id);
    expect(ids).toContain("P-PRINCIPLE-ACTIVE-RETRIEVAL");
    expect(ids).toContain("P-ENGINEERING-SOURCE-FIX");
    expect(ids).toContain("P-RUNTIME-GUARDRAIL");
  });

  it("selects feedback learning loop for principle/experience feedback", () => {
    const types = classifyTask("这些经验怎么沉淀下来，并指导后续工作");
    expect(types.has("feedback_learning")).toBe(true);
    const ids = selectPrinciplesForTask("这些经验怎么沉淀下来，并指导后续工作").map(p => p.id);
    expect(ids).toContain("P-FEEDBACK-LEARNING-LOOP");
  });

  it("renders active principles as prompt obligations", () => {
    const prompt = renderActivePrinciplesForPrompt(selectPrinciplesForTask("修一下这个 bug", undefined, 2));
    expect(prompt).toContain("<active_principles>");
    expect(prompt).toContain("Required actions");
    expect(prompt).toContain("Evaluation must-have");
  });

  it("renders short active principle ids for dynamic runtime context", async () => {
    const { renderActivePrincipleIdsForPrompt } = await import("../principles/prompt.js");
    const prompt = renderActivePrincipleIdsForPrompt(selectPrinciplesForTask("修一下这个 bug", undefined, 2));
    expect(prompt).toContain("<runtime_context>");
    expect(prompt).toContain("P-PRINCIPLE-ACTIVE-RETRIEVAL");
    expect(prompt).not.toContain("Required actions");
  });

  it("evaluates source-fix application with code change, test and validation evidence", () => {
    const principles = selectPrinciplesForTask("这个工具重复调用的 bug 修一下");
    const evidence = createEmptyPrincipleEvidence("这个工具重复调用的 bug 修一下");
    recordToolEvidence(evidence, "read_file", { path: "/repo/domain/agent.ts" });
    recordToolEvidence(evidence, "edit_file", { path: "/repo/domain/agent.ts" });
    recordToolEvidence(evidence, "write_file", { path: "/repo/tests/tool-dedupe.test.ts" });
    recordToolEvidence(evidence, "bash", { command: "npm run typecheck && npm test" });
    evidence.finalResponse = "已在 runtime dispatch 统一入口加入 guardrail，防止复发。";

    const evals = evaluatePrinciples(principles, evidence);
    const sourceFix = evals.find(e => e.principleId === "P-ENGINEERING-SOURCE-FIX");
    expect(sourceFix?.passed).toBe(true);
    const regression = evals.find(e => e.principleId === "P-REGRESSION-TEST");
    expect(regression?.passed).toBe(true);
  });
});
