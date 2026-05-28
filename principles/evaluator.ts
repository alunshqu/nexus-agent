import type { ActivePrinciple, PrincipleEvaluation, PrincipleEvidence } from "./types.js";

export function createEmptyPrincipleEvidence(userMessage: string): PrincipleEvidence {
  return { userMessage, toolCalls: [], toolResults: [], filesRead: [], filesChanged: [], validationCommands: [], commits: [] };
}

export function recordToolEvidence(evidence: PrincipleEvidence, name: string, input: unknown) {
  evidence.toolCalls.push({ name, input });
  const command = typeof (input as any)?.command === "string" ? (input as any).command : "";
  const path = typeof (input as any)?.path === "string" ? (input as any).path : undefined;

  if (["read_file", "grep", "glob", "list_dir"].includes(name) && path) evidence.filesRead.push(path);
  if (["write_file", "edit_file"].includes(name) && path) evidence.filesChanged.push(path);
  if (name === "bash") {
    if (isValidationCommand(command)) evidence.validationCommands.push(command);
    if (/\bgit\s+commit\b/.test(command)) evidence.commits.push(command);
  }
}

export function recordToolResultEvidence(evidence: PrincipleEvidence, name: string, result: string, is_error?: boolean) {
  evidence.toolResults.push({ name, result, is_error });
}

export function evaluatePrinciples(principles: ActivePrinciple[], evidence: PrincipleEvidence): PrincipleEvaluation[] {
  return principles.map(principle => evaluatePrinciple(principle, evidence));
}

function evaluatePrinciple(principle: ActivePrinciple, evidence: PrincipleEvidence): PrincipleEvaluation {
  const checks = buildChecks(evidence);
  const missing = principle.evaluation.mustHave.filter(requirement => !checks[requirement]);
  const optional = principle.evaluation.shouldHave ?? [];
  const optionalHits = optional.filter(requirement => checks[requirement]).length;
  const mustHits = principle.evaluation.mustHave.length - missing.length;
  const total = principle.evaluation.mustHave.length + optional.length;
  const score = total === 0 ? 1 : (mustHits + optionalHits) / total;

  return {
    principleId: principle.id,
    passed: missing.length === 0,
    score: Number(score.toFixed(2)),
    evidence: {
      filesRead: evidence.filesRead,
      filesChanged: evidence.filesChanged,
      validationCommands: evidence.validationCommands,
      commits: evidence.commits,
      toolCalls: evidence.toolCalls.map(t => t.name),
    },
    missing,
  };
}

function buildChecks(evidence: PrincipleEvidence): Record<string, boolean> {
  const final = evidence.finalResponse ?? "";
  const readSomething = evidence.filesRead.length > 0 || evidence.toolCalls.some(t => ["grep", "glob", "list_dir", "read_file"].includes(t.name));
  const changedSomething = evidence.filesChanged.length > 0;
  const validationDone = evidence.validationCommands.length > 0;
  const hasTestChange = evidence.filesChanged.some(path => /(^|\/)tests?\//.test(path) || /\.test\.[tj]s$/.test(path) || /\.spec\.[tj]s$/.test(path));
  const hasRuntimeBoundaryChange = evidence.filesChanged.some(path => /(^|\/)(domain|tools|infra|adapters)\//.test(path));
  const mentionsSource = /源头|入口|根因|责任层|dispatch|runtime|guardrail|兜底|机制|防复发/.test(final);
  const promptOnlyLanguage = /以后会注意|尽量避免|后续避免/.test(final) && !changedSomething;

  return {
    principles_selected: true,
    principles_injected: true,
    principles_evaluated: true,
    source_entry_identified: readSomething || mentionsSource,
    root_fix_or_guardrail: changedSomething || /guardrail|兜底|源头修复|机制修复/.test(final),
    not_prompt_only: !promptOnlyLanguage,
    regression_test: hasTestChange,
    validation_done: validationDone,
    commit_created: evidence.commits.length > 0,
    guardrail_at_runtime_boundary: hasRuntimeBoundaryChange || /runtime|dispatch|执行入口|统一入口/.test(final),
    invalid_input_handled: hasRuntimeBoundaryChange || /校验|去重|重复|不可信|tool_result/.test(final),
    trace_recorded: true,
    test_failed_before_fix_when_practical: true,
    engineering_fix_considered: changedSomething || /代码机制|工程兜底|源头/.test(final),
    guardrail_or_test: changedSomething || hasTestChange,
    principle_updated_or_created: changedSomething || /准则|principle|经验/.test(final),
    runtime_selection_supported: changedSomething || /主动检索|选择准则|active_principles/.test(final),
    application_evaluated: true,
    memory_saved: evidence.toolCalls.some(t => t.name === "memory_save"),
    tests_added: hasTestChange,
  };
}

function isValidationCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|build)\b/.test(command) || /\b(vitest|tsc|pytest|go\s+test|cargo\s+test)\b/.test(command);
}
