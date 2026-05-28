import AiBot from "@wecom/aibot-node-sdk";
import type { WsFrame } from "@wecom/aibot-node-sdk";
import { generateReqId } from "@wecom/aibot-node-sdk";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { runAgent, interruptAgent } from "../domain/agent.js";
import type { AgentOptions, SessionState } from "../domain/types.js";
import { createSession, loadSession, saveSession, saveMessage, prepareForNewUserMessage, registerSession, updateSessionStatus, setInMemorySession, getInMemorySession } from "../infra/session.js";
import { createLogger } from "../infra/logger.js";
import { formatTokenUsage } from "../infra/usage.js";

const logger = createLogger("wecom");
const MEDIA_DIR = path.join(os.homedir(), ".agent", "media");

let wsClient: InstanceType<typeof AiBot.WSClient> | null = null;

async function downloadAndSave(url: string, aeskey: string | undefined, fallbackName: string): Promise<string> {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const { buffer, filename } = await wsClient!.downloadFile(url, aeskey);
  const fname = filename ?? fallbackName;
  const filePath = path.join(MEDIA_DIR, `${Date.now()}_${fname}`);
  writeFileSync(filePath, buffer);
  return filePath;
}

export function initWecom(opts: Omit<AgentOptions, "onEvent">) {
  const botId = process.env.WECOM_BOT_ID;
  const secret = process.env.WECOM_SECRET ?? process.env.WECOM_BOT_SECRET;
  if (!botId || !secret) {
    logger.info("skipped", { reason: "WECOM_BOT_ID or WECOM_SECRET not set" });
    return;
  }

  wsClient = new AiBot.WSClient({ botId, secret });
  wsClient.connect();

  wsClient.on("authenticated", () => { logger.info("authenticated"); });
  wsClient.on("disconnected", () => { logger.info("disconnected"); });
  wsClient.on("error", (err: Error) => { logger.error("client_error", err); });

  wsClient.on("event.enter_chat", (frame: WsFrame) => {
    wsClient!.replyWelcome(frame, { msgtype: "text", text: { content: "你好！我是智能助手，有什么可以帮你的？" } });
  });

  const dispatch = (frame: WsFrame, text: string) => handleMessage(frame, text, opts);

  wsClient.on("message.text", (frame: WsFrame) => {
    dispatch(frame, frame.body.text?.content ?? "");
  });

  wsClient.on("message.voice", (frame: WsFrame) => {
    // voice.content is already transcribed text by the platform
    dispatch(frame, frame.body.voice?.content ?? "");
  });

  wsClient.on("message.image", (frame: WsFrame) => {
    const img = frame.body.image;
    if (img?.url) {
      downloadAndSave(img.url, img.aeskey, "image.jpg")
        .then(p => dispatch(frame, `[用户发送了一张图片，已保存至：${p}]`))
        .catch(e => { logger.error("image_download_failed", e); dispatch(frame, "[用户发送了一张图片，下载失败]"); });
    } else {
      dispatch(frame, "[用户发送了一张图片]");
    }
  });

  wsClient.on("message.video", (frame: WsFrame) => {
    const vid = frame.body.video;
    if (vid?.url) {
      downloadAndSave(vid.url, vid.aeskey, "video.mp4")
        .then(p => dispatch(frame, `[用户发送了一个视频，已保存至：${p}]`))
        .catch(e => { logger.error("video_download_failed", e); dispatch(frame, "[用户发送了一个视频，下载失败]"); });
    } else {
      dispatch(frame, "[用户发送了一个视频]");
    }
  });

  wsClient.on("message.file", (frame: WsFrame) => {
    const file = frame.body.file;
    if (file?.url) {
      const name: string = file.name ?? "file";
      downloadAndSave(file.url, file.aeskey, name)
        .then(p => dispatch(frame, `[用户发送了文件：${name}，已保存至：${p}]`))
        .catch(e => { logger.error("file_download_failed", e); dispatch(frame, `[用户发送了文件：${name}，下载失败]`); });
    } else {
      dispatch(frame, "[用户发送了一个文件]");
    }
  });

  wsClient.on("message.mixed", (frame: WsFrame) => {
    const items: any[] = frame.body.mixed?.msg_item ?? [];
    const downloads: Promise<string>[] = [];
    const parts: string[] = [];

    for (const i of items) {
      if (i.msgtype === "text") {
        parts.push(i.text?.content ?? "");
      } else if (i.msgtype === "image" && i.image?.url) {
        const idx = parts.length;
        parts.push("[图片下载中...]");
        downloads.push(
          downloadAndSave(i.image.url, i.image.aeskey, "image.jpg")
            .then(p => { parts[idx] = `[图片，已保存至：${p}]`; return p; })
            .catch(() => { parts[idx] = "[图片，下载失败]"; return ""; })
        );
      }
    }

    Promise.all(downloads).then(() => {
      const text = parts.filter(Boolean).join("\n");
      if (text) dispatch(frame, text);
    });
  });
}

const activeSessions = new Map<string, SessionState>();

async function handleMessage(frame: WsFrame, text: string, opts: Omit<AgentOptions, "onEvent">) {
  if (!text.trim() || !wsClient) return;

  const chatId = frame.body?.from?.userid ?? frame.headers?.from_chat_id ?? frame.headers?.req_id ?? "default";
  let state = activeSessions.get(chatId) ?? loadSession(chatId) ?? createSession(chatId);
  state.channelId = chatId;
  activeSessions.set(chatId, state);
  setInMemorySession(state.id, state);
  registerSession(state.id, "wecom");

  // Slash commands are highest priority — handle before running check
  if (text.trim().startsWith("/")) {
    const { handleSlashCommand } = await import("../commands.js");
    if (text.trim() === "/stop" || text.trim() === "/interrupt") {
      interruptAgent(state);
      wsClient.replyStream(frame, generateReqId("stream"), "已中断。", true).catch(() => {});
      return;
    }
    const result = await handleSlashCommand(text.trim(), state, opts);
    if (result) {
      wsClient.replyStream(frame, generateReqId("stream"), result, true).catch(() => {});
      return;
    }
  }

  if (state.running) {
    wsClient.replyStream(frame, generateReqId("stream"), "正在处理上一条消息，请稍候...", true);
    return;
  }

  state.running = true;

  const streamId = generateReqId("stream");
  const statusStreamId = generateReqId("status");
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    saveSession(state);
    prepareForNewUserMessage(state);
    state.messages.push({ role: "user", content: text.trim() });
    saveMessage(state.id, "user", text.trim());

    // Inject wecom channel capabilities
    state.channel = {
      sendMedia: async (filePath, mediaType, filename) => {
        if (!wsClient) return { ok: false, error: "WeCom client not connected" };
        try {
          const buffer = readFileSync(filePath);
          const fname = filename ?? filePath.split("/").pop() ?? "file";
          const { media_id } = await wsClient.uploadMedia(buffer, { type: mediaType, filename: fname });
          await wsClient.sendMediaMessage(chatId, mediaType, media_id);
          logger.info("media_sent", { sessionId: state.id, chatId, mediaType, filename: fname });
          return { ok: true };
        } catch (error) {
          logger.error("media_send_failed", error, { sessionId: state.id, chatId, mediaType, filePath });
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    };

    // Immediately acknowledge receipt
    const ackId = generateReqId("stream");
    wsClient.replyStream(frame, ackId, "处理中...", true).catch((error) => {
      logger.error("reply_ack_failed", error, { sessionId: state.id, chatId });
    });

    let fullContent = "";
    let finalUsage: import("../infra/provider.js").TokenUsage | undefined;
    let lastTextAt = Date.now();
    let statusContent = "⏳ 思考中...";
    let resultStarted = false;

    // Heartbeat: if no text output for 30s, update status bubble
    heartbeatTimer = setInterval(() => {
      if (resultStarted || !state.running) { clearInterval(heartbeatTimer); return; }
      const elapsed = Math.floor((Date.now() - lastTextAt) / 1000);
      if (elapsed >= 30) {
        statusContent = `⏳ 处理中... (${elapsed}s)`;
        wsClient!.replyStream(frame, statusStreamId, statusContent, false).catch(() => {});
      }
    }, 10000);

    await runAgent(state, {
      ...opts,
      onEvent: (event) => {
        if (event.type === "tool_use") {
          // B: update status on each tool call
          const toolLabel: Record<string, string> = {
            web_search: "🔍 搜索中",
            web_fetch: "🌐 获取页面",
            bash: "⚙️ 执行命令",
            read_file: "📖 读取文件",
            write_file: "📝 写入文件",
            edit_file: "✏️ 编辑文件",
            browser_navigate: "🌐 打开页面",
            browser_screenshot: "📸 截图",
            agent_run: "🤖 调用子 agent",
            agents_run_parallel: "🤖 并行子 agent",
          };
          statusContent = `${toolLabel[event.name] ?? `🔧 ${event.name}`}...`;
          wsClient!.replyStream(frame, statusStreamId, statusContent, false).catch(() => {});
        } else if (event.type === "text") {
          lastTextAt = Date.now();
          if (!resultStarted) {
            // Close status bubble when result starts
            resultStarted = true;
            clearInterval(heartbeatTimer);
            wsClient!.replyStream(frame, statusStreamId, statusContent, true).catch(() => {});
          }
          fullContent += event.delta;
          if (fullContent.length % 200 < event.delta.length || event.delta.includes("\n")) {
            wsClient!.replyStream(frame, streamId, fullContent, false).catch((error) => {
              logger.error("reply_stream_failed", error, { sessionId: state.id, chatId, streamId, final: false });
            });
          }
        } else if (event.type === "done") {
          finalUsage = event.usage;
        }
      },
    });

    clearInterval(heartbeatTimer);
    // Close status bubble if result never started (e.g. tool-only response)
    if (!resultStarted) {
      wsClient!.replyStream(frame, statusStreamId, statusContent, true).catch(() => {});
    }

    const finalText = fullContent || "完成。";
    wsClient.replyStream(frame, streamId, finalText, true).catch((error) => {
      logger.error("reply_stream_failed", error, { sessionId: state.id, chatId, streamId, final: true });
    });
    if (finalUsage) {
      wsClient.sendMessage(chatId, { msgtype: "markdown", markdown: { content: formatTokenUsage(finalUsage) } }).catch((error) => {
        logger.error("usage_message_send_failed", error, { sessionId: state.id, chatId });
      });
    }
  } catch (error) {
    clearInterval(heartbeatTimer);
    logger.error("run_agent_exception", error, { sessionId: state.id, chatId, entrypoint: "wecom" });
    const errMsg = error instanceof Error ? error.message : String(error);
    wsClient.replyStream(frame, statusStreamId, `❌ 出错了`, true).catch(() => {});
    wsClient.replyStream(frame, streamId, `错误：${errMsg}`, true).catch((replyError) => {
      logger.error("reply_error_failed", replyError, { sessionId: state.id, chatId, streamId });
    });
  } finally {
    state.running = false;
    state.currentStream = undefined;
    updateSessionStatus(state.id, { running: false, currentTool: undefined, currentPhase: undefined });
  }
}

export function disconnectWecom() {
  wsClient?.disconnect();
}

export async function sendToWecomChannel(chatid: string, text: string): Promise<void> {
  if (!wsClient) throw new Error("WeCom client not connected");
  await wsClient.sendMessage(chatid, { msgtype: "markdown", markdown: { content: text } });
}

