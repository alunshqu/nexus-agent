import type Anthropic from "@anthropic-ai/sdk";
import type { ChildProcess } from "child_process";
import type { Provider, TokenUsage } from "../infra/provider.js";

export type { Provider, TokenUsage, ProviderConfig } from "../infra/provider.js";

export type ChannelCapabilities = {
  /** Send a media file to the current conversation. Returns media_id or error. */
  sendMedia?: (filePath: string, mediaType: "image" | "file" | "video" | "voice", filename?: string) => Promise<{ ok: boolean; error?: string }>;
};

export type SessionState = {
  id: string;
  cwd: string;
  running: boolean;
  messages: Anthropic.MessageParam[];
  activeChildren: Set<ChildProcess>;
  currentStream?: { abort?: () => void };
  channel?: ChannelCapabilities;
  lastInputTokens?: number;
  channelId?: string;  // channel-specific user/chat identifier (e.g. wecom userid)
  lastActivityAt?: number; // timestamp of previous completed user turn; used for prompt-cache cold-start decisions
};

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: string; is_error: boolean }
  | { type: "done"; traceId: string; usage: TokenUsage }
  | { type: "error"; message: string };

export type AgentOptions = {
  provider: Provider;
  systemPrompt: string;
  onEvent: (event: AgentEvent) => void;
};
