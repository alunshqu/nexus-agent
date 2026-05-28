// IM adapter interface — implement this for WeChat Work, Feishu, DingTalk, etc.
import { runAgent, interruptAgent } from "../domain/agent.js";
import type { AgentOptions } from "../domain/types.js";
import { createSession, loadSession, saveSession, saveMessage, prepareForNewUserMessage } from "../infra/session.js";
import { createLogger } from "../infra/logger.js";

const logger = createLogger("im");

export interface IMAdapter {
  /** Register handler for incoming messages */
  onMessage(handler: (sessionId: string, userId: string, text: string) => void): void;
  /** Send text message to a user/session */
  sendMessage(sessionId: string, text: string): Promise<void>;
  /** Send typing indicator */
  sendTyping?(sessionId: string): Promise<void>;
}

/** Connects an IM adapter to the agent */
export function connectIMAdapter(adapter: IMAdapter, opts: Omit<AgentOptions, "onEvent">) {
  adapter.onMessage(async (sessionId, userId, text) => {
    const state = loadSession(sessionId) ?? createSession(sessionId);
    if (state.running) {
      await adapter.sendMessage(sessionId, "正在处理上一条消息，请稍候...");
      return;
    }

    saveSession(state);
    state.running = true;
    prepareForNewUserMessage(state);
    state.messages.push({ role: "user", content: text });
    saveMessage(state.id, "user", text);

    await adapter.sendTyping?.(sessionId);

    const textParts: string[] = [];
    try {
      await runAgent(state, {
        ...opts,
        onEvent: (event) => {
          if (event.type === "text") textParts.push(event.delta);
        },
      });
      const reply = textParts.join("").trim();
      if (reply) await adapter.sendMessage(sessionId, reply);
    } catch (error) {
      logger.error("run_agent_exception", error, { sessionId: state.id, userId, entrypoint: "im" });
      await adapter.sendMessage(sessionId, `错误：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.running = false;
      state.currentStream = undefined;
    }
  });
}
