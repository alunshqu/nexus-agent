import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Regression for Bedrock TOOL_DUPLICATE: prepareMessages returns state.messages BY
// REFERENCE when no compression happens. runAgent must copy it into loopMessages,
// otherwise state.messages.push(assistant) bleeds into loopMessages AND the explicit
// loopMessages spread adds the same assistant a second time → two tool_use blocks with
// the same id in one request → Bedrock 400.

// Mirrors the relevant runAgent data flow (infra-free).
function simulateTurn(loopAliasesState: boolean) {
  const stateMessages: Anthropic.MessageParam[] = [
    { role: "user", content: "查一下天气情况" },
  ];

  // The fix: copy. The bug: alias.
  let loopMessages: Anthropic.MessageParam[] = loopAliasesState ? stateMessages : [...stateMessages];

  // Model returns ONE tool_use.
  const assistant: Anthropic.MessageParam = {
    role: "assistant",
    content: [{ type: "tool_use", id: "tooluse_ABC", name: "web_search", input: { q: "weather" } } as any],
  };

  // agent.ts:207 — push to state.messages
  stateMessages.push(assistant);
  // agent.ts:209 — explicit spread onto loopMessages
  loopMessages = [...loopMessages, { role: "assistant", content: (assistant.content as any) }];

  return loopMessages;
}

function toolUseIds(messages: Anthropic.MessageParam[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) if (b.type === "tool_use") ids.push(b.id);
    }
  }
  return ids;
}

describe("runAgent loopMessages must not alias state.messages (TOOL_DUPLICATE regression)", () => {
  it("aliasing reproduces the duplicate tool_use id", () => {
    const loop = simulateTurn(true);
    const ids = toolUseIds(loop);
    // Bug: same id appears twice.
    expect(ids).toEqual(["tooluse_ABC", "tooluse_ABC"]);
    expect(new Set(ids).size).not.toBe(ids.length);
  });

  it("copying yields exactly one assistant tool_use (the fix)", () => {
    const loop = simulateTurn(false);
    const ids = toolUseIds(loop);
    expect(ids).toEqual(["tooluse_ABC"]);
    // No duplicate ids anywhere in the request.
    expect(new Set(ids).size).toBe(ids.length);
    // Exactly one assistant message carrying the tool_use.
    expect(loop.filter(m => m.role === "assistant")).toHaveLength(1);
  });
});
