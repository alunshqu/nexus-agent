export type PrincipleLevel = "mandatory" | "recommended";

export type PrincipleTaskType =
  | "code_change"
  | "bug_fix"
  | "runtime_issue"
  | "agent_self_correction"
  | "feedback_learning"
  | "research"
  | "general";

export type PrincipleCard = {
  id: string;
  title: string;
  level: PrincipleLevel;
  summary: string;
  appliesTo: PrincipleTaskType[];
  triggers: string[];
  wrongPatterns: string[];
  requiredActions: string[];
  evaluation: {
    mustHave: string[];
    shouldHave?: string[];
  };
};

export type ActivePrinciple = PrincipleCard & {
  score: number;
  matchedTriggers: string[];
};

export type PrincipleEvidence = {
  userMessage: string;
  toolCalls: Array<{ name: string; input?: unknown }>;
  toolResults: Array<{ name: string; result?: string; is_error?: boolean }>;
  filesRead: string[];
  filesChanged: string[];
  validationCommands: string[];
  commits: string[];
  finalResponse?: string;
};

export type PrincipleEvaluation = {
  principleId: string;
  passed: boolean;
  score: number;
  evidence: Record<string, unknown>;
  missing: string[];
};
