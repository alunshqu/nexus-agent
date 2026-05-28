import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// ── Extracted repairMessages (mirrors infra/session.ts) ───────────────────────
// Tested in isolation — no DB dependency.

function repairMessages(messages: Anthropic.MessageParam[]) {
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "assistant" && Array.isArray(last.content) && (last.content as any[]).some(b => b.type === "tool_use")) {
      messages.pop(); continue;
    }
    if (last.role === "user" && Array.isArray(last.content) && (last.content as any[]).some(b => b.type === "tool_result")) {
      messages.pop(); continue;
    }
    break;
  }

  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    const validToolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content))
        for (const b of msg.content as any[]) if (b.type === "tool_use" && b.id) validToolUseIds.add(b.id);
      if (msg.role === "user" && Array.isArray(msg.content))
        for (const b of msg.content as any[]) if (b.type === "tool_result" && b.tool_use_id) toolResultIds.add(b.tool_use_id);
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const blocks = (msg.content as any[]).filter(b => b.type !== "tool_use" || toolResultIds.has(b.id));
        if (blocks.length !== msg.content.length) {
          changed = true;
          if (blocks.length === 0 || blocks.every((b: any) => b.type === "thinking")) messages.splice(i, 1);
          else messages[i] = { ...msg, content: blocks as any };
        }
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        const blocks = (msg.content as any[]).filter(b => b.type !== "tool_result" || validToolUseIds.has(b.tool_use_id));
        if (blocks.length !== msg.content.length) {
          changed = true;
          if (blocks.length === 0) messages.splice(i, 1);
          else messages[i] = { ...msg, content: blocks as any };
        }
      }
    }
    if (!changed) break;
  }

  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role) messages.splice(i, 1);
  }
  while (messages.length > 0 && messages[0].role !== "user") messages.shift();
}

// ── helpers ───────────────────────────────────────────────────────────────────

const user = (content: string): Anthropic.MessageParam => ({ role: "user", content });
const assistant = (content: string): Anthropic.MessageParam => ({ role: "assistant", content });
const toolUse = (id: string): Anthropic.MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "bash", input: {} }],
});
const toolResult = (id: string): Anthropic.MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "result" }],
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("repairMessages", () => {
  it("no-op on valid conversation", () => {
    const msgs = [user("hi"), assistant("hello")];
    repairMessages(msgs);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("drops trailing assistant with tool_use (no matching result)", () => {
    const msgs = [user("hi"), toolUse("t1")];
    repairMessages(msgs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(user("hi"));
  });

  it("drops trailing user with tool_result (orphaned)", () => {
    const msgs = [user("hi"), assistant("ok"), toolResult("t1")];
    repairMessages(msgs);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("assistant");
  });

  it("keeps valid tool_use + tool_result pair", () => {
    const msgs = [user("hi"), toolUse("t1"), toolResult("t1"), assistant("done")];
    repairMessages(msgs);
    expect(msgs).toHaveLength(4);
  });

  it("removes tool_use with no matching tool_result mid-conversation", () => {
    const msgs: Anthropic.MessageParam[] = [
      user("hi"),
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "bash", input: {} }, { type: "text" as const, text: "thinking" }] },
      user("next"),
    ];
    repairMessages(msgs);
    // tool_use t1 has no result → removed from assistant block
    const assistantMsg = msgs.find(m => m.role === "assistant");
    if (assistantMsg && Array.isArray(assistantMsg.content)) {
      expect((assistantMsg.content as any[]).some(b => b.type === "tool_use")).toBe(false);
    }
  });

  it("removes orphan tool_result with no matching tool_use", () => {
    const msgs: Anthropic.MessageParam[] = [
      user("hi"),
      assistant("ok"),
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "nonexistent", content: "result" } as any] },
      assistant("done"),
    ];
    repairMessages(msgs);
    // orphan tool_result user message should be removed
    const userMsgs = msgs.filter(m => m.role === "user");
    for (const u of userMsgs) {
      if (Array.isArray(u.content)) {
        expect((u.content as any[]).some(b => b.type === "tool_result")).toBe(false);
      }
    }
  });

  it("removes consecutive same-role messages (keeps first)", () => {
    const msgs = [user("hi"), user("hello"), assistant("ok")];
    repairMessages(msgs);
    expect(msgs.filter(m => m.role === "user")).toHaveLength(1);
  });

  it("must start with user — drops leading assistant", () => {
    const msgs = [assistant("hi"), user("hello")];
    repairMessages(msgs);
    expect(msgs[0].role).toBe("user");
  });

  it("empty array stays empty", () => {
    const msgs: Anthropic.MessageParam[] = [];
    repairMessages(msgs);
    expect(msgs).toHaveLength(0);
  });

  it("all-assistant array becomes empty", () => {
    const msgs = [assistant("a"), assistant("b")];
    repairMessages(msgs);
    expect(msgs).toHaveLength(0);
  });

  it("valid tool pair survives repair", () => {
    const msgs = [user("run"), toolUse("t1"), toolResult("t1"), assistant("done")];
    const before = JSON.stringify(msgs);
    repairMessages(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});
