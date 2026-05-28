import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../domain/agent.js";

// ── Extracted progress logic (mirrors wecom.ts handleMessage) ─────────────────
// We test the pure event-handling logic in isolation, without real WebSocket or PM2.

type ReplyCall = { streamId: string; content: string; final: boolean };

function createProgressHandler(statusStreamId: string, streamId: string) {
  const calls: ReplyCall[] = [];
  const replyStream = (frame: unknown, sid: string, content: string, final: boolean) => {
    calls.push({ streamId: sid, content, final });
    return Promise.resolve({} as any);
  };

  let fullContent = "";
  let lastTextAt = Date.now();
  let statusContent = "⏳ 思考中...";
  let resultStarted = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      if (resultStarted) { clearInterval(heartbeatTimer); return; }
      const elapsed = Math.floor((Date.now() - lastTextAt) / 1000);
      if (elapsed >= 30) {
        statusContent = `⏳ 处理中... (${elapsed}s)`;
        replyStream(null, statusStreamId, statusContent, false);
      }
    }, 10000);
  };

  const onEvent = (event: AgentEvent) => {
    if (event.type === "tool_use") {
      const toolLabel: Record<string, string> = {
        web_search: "🔍 搜索中",
        bash: "⚙️ 执行命令",
        write_file: "📝 写入文件",
      };
      statusContent = `${toolLabel[event.name] ?? `🔧 ${event.name}`}...`;
      replyStream(null, statusStreamId, statusContent, false);
    } else if (event.type === "text") {
      lastTextAt = Date.now();
      if (!resultStarted) {
        resultStarted = true;
        clearInterval(heartbeatTimer);
        replyStream(null, statusStreamId, statusContent, true);
      }
      fullContent += event.delta;
      if (fullContent.length % 200 < event.delta.length || event.delta.includes("\n")) {
        replyStream(null, streamId, fullContent, false);
      }
    }
  };

  const finish = (error?: Error) => {
    clearInterval(heartbeatTimer);
    if (error) {
      replyStream(null, statusStreamId, "❌ 出错了", true);
      replyStream(null, streamId, `错误：${error.message}`, true);
    } else {
      if (!resultStarted) {
        replyStream(null, statusStreamId, statusContent, true);
      }
      replyStream(null, streamId, fullContent || "完成。", true);
    }
  };

  return { onEvent, finish, startHeartbeat, calls, getFullContent: () => fullContent };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("wecom progress bubble", () => {
  const STATUS = "status-id";
  const RESULT = "result-id";

  it("tool_use updates status bubble", () => {
    const { onEvent, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "tool_use", name: "web_search", input: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ streamId: STATUS, content: "🔍 搜索中...", final: false });
  });

  it("first text closes status bubble and opens result bubble", () => {
    const { onEvent, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "tool_use", name: "bash", input: {} });
    onEvent({ type: "text", delta: "hello world\n" });
    // status update from tool_use, then status close, then result chunk
    expect(calls[0]).toMatchObject({ streamId: STATUS, final: false });
    expect(calls[1]).toMatchObject({ streamId: STATUS, final: true }); // close status
    expect(calls[2]).toMatchObject({ streamId: RESULT, content: "hello world\n", final: false });
  });

  it("subsequent text does not re-close status bubble", () => {
    const { onEvent, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "text", delta: "first\n" });
    onEvent({ type: "text", delta: "second\n" });
    const statusCloseCalls = calls.filter(c => c.streamId === STATUS && c.final);
    expect(statusCloseCalls).toHaveLength(1); // only closed once
  });

  it("finish with no text output closes status and sends 完成", () => {
    const { onEvent, finish, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "tool_use", name: "write_file", input: {} });
    finish();
    const statusClose = calls.find(c => c.streamId === STATUS && c.final);
    const resultFinal = calls.find(c => c.streamId === RESULT && c.final);
    expect(statusClose).toBeDefined();
    expect(resultFinal?.content).toBe("完成。");
  });

  it("finish with text output sends accumulated content as final", () => {
    const { onEvent, finish, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "text", delta: "part1\n" });
    onEvent({ type: "text", delta: "part2\n" });
    finish();
    const resultFinal = calls.find(c => c.streamId === RESULT && c.final);
    expect(resultFinal?.content).toBe("part1\npart2\n");
  });

  it("error closes status with ❌ and sends error to result bubble", () => {
    const { finish, calls } = createProgressHandler(STATUS, RESULT);
    finish(new Error("API timeout"));
    expect(calls[0]).toMatchObject({ streamId: STATUS, content: "❌ 出错了", final: true });
    expect(calls[1]).toMatchObject({ streamId: RESULT, content: "错误：API timeout", final: true });
  });

  it("error after tool_use closes status correctly", () => {
    const { onEvent, finish, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "tool_use", name: "bash", input: {} });
    finish(new Error("tool failed"));
    const statusClose = calls.find(c => c.streamId === STATUS && c.final);
    expect(statusClose?.content).toBe("❌ 出错了");
  });

  it("unknown tool name falls back to generic label", () => {
    const { onEvent, calls } = createProgressHandler(STATUS, RESULT);
    onEvent({ type: "tool_use", name: "my_custom_tool", input: {} });
    expect(calls[0].content).toBe("🔧 my_custom_tool...");
  });
});
