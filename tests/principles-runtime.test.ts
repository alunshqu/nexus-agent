import { describe, it, expect } from "vitest";
import { selectPrinciplesForTask, classifyTask } from "../principles/selector.js";
import { renderPrincipleRegistryForPrompt } from "../principles/prompt.js";
import { PRINCIPLE_CARDS } from "../principles/registry.js";
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

  it("renders the full principle registry as a STATIC, deterministic block (cache-safe)", () => {
    // The registry block lives in the cached system prompt. It must be byte-identical
    // across calls (no per-turn/user input) so it never busts the prompt prefix cache.
    const a = renderPrincipleRegistryForPrompt();
    const b = renderPrincipleRegistryForPrompt();
    expect(a).toBe(b);
    expect(a).toContain("<work_principles>");
    // Every principle id must be present so the model can self-select per task.
    for (const card of PRINCIPLE_CARDS) {
      expect(a).toContain(card.id);
      expect(a).toContain(card.title);
    }
    // Must NOT contain any per-turn marker that would vary the prefix.
    expect(a).not.toContain("for this turn");
    expect(a).not.toContain("Matched triggers");
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
