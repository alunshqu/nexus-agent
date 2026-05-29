import type { TokenUsage } from "../infra/provider.js";
import type { SessionState } from "./types.js";
import { saveMessage, updateSessionStatus } from "../infra/session.js";
import { createLogger } from "../infra/logger.js";
import { selectWorkflowForTask, type WorkflowSelection } from "../workflows/selector.js";
import { buildAgentTeamWorkflow } from "../workflows/agent-team.js";
import { getWorkflowTemplate } from "../workflows/templates.js";
import { createWorkflowStore } from "../workflows/store.js";
import { runWorkflow } from "../workflows/runtime.js";
import { createTaskWorkflowExecutor, finalizeWorkflowArtifacts, formatWorkflowProgress } from "../workflows/executors.js";

const logger = createLogger("workflow_auto");
const EMPTY_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

export type AutoWorkflowResult = {
  handled: boolean;
  text?: string;
  selection?: WorkflowSelection;
};

export function shouldAutoHandleWorkflow(userMessage: string, selection: WorkflowSelection): boolean {
  if (process.env.WORKFLOW_AUTO_MAIN_LOOP === "0") return false;
  if (userMessage.trim().startsWith("/")) return false;
  if (selection.mode !== "workflow") return false;
  if (selection.confidence < Number(process.env.WORKFLOW_AUTO_CONFIDENCE ?? 0.72)) return false;

  // Guardrail: only auto-run workflow paths that have real executors. Research is now
  // backed by web_search/web_fetch. Code/kb are still kept out of main-loop auto mode
  // until their executors perform real file/KB operations rather than scaffolding.
  return selection.kind === "research" || selection.templateId === "brainstorm-council" || selection.templateId === "general-task";
}

export async function maybeHandleAutoWorkflow(
  state: SessionState,
  userMessage: string,
  onText: (text: string) => void
): Promise<AutoWorkflowResult> {
  const selection = selectWorkflowForTask(userMessage);
  if (!shouldAutoHandleWorkflow(userMessage, selection)) return { handled: false, selection };
  if (selection.mode !== "workflow") return { handled: false, selection };

  const workflow = selection.templateId
    ? getWorkflowTemplate(selection.templateId)?.build(userMessage)
    : selection.kind
    ? buildAgentTeamWorkflow(selection.kind, userMessage)
    : undefined;
  if (!workflow) return { handled: false, selection };

  const store = createWorkflowStore();
  const run = store.createRun(workflow);
  store.appendEvent(run.id, "run_created", { source: "agent_main_loop", selection, sessionId: state.id });

  updateSessionStatus(state.id, { running: true, currentPhase: "workflow", currentTool: undefined });
  onText(`我会把这个复杂任务作为可追踪 workflow 来处理。\n\n- workflow：${run.id}\n- 模板：${selection.templateId}\n- 原因：${selection.reason}\n\n开始执行...\n\n`);

  try {
    const result = await runWorkflow({ store, runId: run.id, executor: createTaskWorkflowExecutor(store) });
    finalizeWorkflowArtifacts(store, result);
    const artifacts = store.listArtifacts(result.id);
    const finalReport = artifacts.find(a => a.name === "final-report.md");
    const summary = formatWorkflowProgress(result);
    const text = finalReport
      ? `✅ Workflow 执行完成：${result.id}\n\n${finalReport.content}`
      : `✅ Workflow 执行完成：${result.id}\n\n${summary}`;

    state.messages.push({ role: "assistant", content: text });
    saveMessage(state.id, "assistant", text);
    updateSessionStatus(state.id, { running: false, currentPhase: undefined, currentTool: undefined, messageCount: state.messages.length });
    onText(text);
    return { handled: true, text, selection };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("auto_workflow_failed", error, { sessionId: state.id, runId: run.id, selection });
    const text = `Workflow 自动执行失败：${message}\n已保留 workflow run：${run.id}，可用 /workflow show ${run.id.slice(0, 8)} 查看。`;
    state.messages.push({ role: "assistant", content: text });
    saveMessage(state.id, "assistant", text);
    updateSessionStatus(state.id, { running: false, currentPhase: undefined, currentTool: undefined, messageCount: state.messages.length });
    onText(text);
    return { handled: true, text, selection };
  }
}

export function emptyWorkflowUsage(): TokenUsage {
  return { ...EMPTY_USAGE };
}
