import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildResponsesInput } from "../infra/provider.js";

describe("buildResponsesInput — OpenAI Responses API cache stability", () => {
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "第一条问题" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我来查一下" } as any,
        { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } } as any,
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "结果数据" } as any],
    },
  ];

  it("converts assistant tool_use to function_call and tool_result to function_call_output", () => {
    const items = buildResponsesInput(undefined, history) as any[];
    expect(items[0]).toEqual({ role: "user", content: "第一条问题" });
    expect(items.find(i => i.type === "function_call")).toMatchObject({ call_id: "call_1", name: "search" });
    expect(items.find(i => i.type === "function_call_output")).toMatchObject({ call_id: "call_1", output: "结果数据" });
  });

  it("appends systemSuffix as the LAST input item (after tool output) so it never pollutes the cache prefix", () => {
    const suffix = "\n<context>\n日期：2026-05-29\n</context>";
    const items = buildResponsesInput(suffix, history) as any[];
    const last = items[items.length - 1];
    expect(last).toEqual({ role: "user", content: suffix });
    // The function_call_output must come BEFORE the trailing suffix, not after.
    const suffixIdx = items.length - 1;
    const outputIdx = items.findIndex(i => i.type === "function_call_output");
    expect(outputIdx).toBeLessThan(suffixIdx);
  });

  it("keeps the prefix (everything except the tail) identical whether or not systemSuffix is present", () => {
    const withoutSuffix = buildResponsesInput(undefined, history) as any[];
    const withSuffix = buildResponsesInput("动态尾巴", history) as any[];
    // withSuffix is withoutSuffix + one trailing item — prefix is byte-identical.
    expect(withSuffix.slice(0, withoutSuffix.length)).toEqual(withoutSuffix);
    expect(withSuffix.length).toBe(withoutSuffix.length + 1);
  });

  it("omits the trailing item entirely when systemSuffix is empty", () => {
    const items = buildResponsesInput("", history) as any[];
    expect(items[items.length - 1]).not.toEqual({ role: "user", content: "" });
    expect(items.some(i => i.role === "user" && i.content === "")).toBe(false);
  });

  it("changing only systemSuffix does not change any prefix item (cache-prefix invariant)", () => {
    const day1 = buildResponsesInput("日期：2026-05-29", history) as any[];
    const day2 = buildResponsesInput("日期：2026-05-30", history) as any[];
    expect(day2.slice(0, -1)).toEqual(day1.slice(0, -1));
    expect(day2[day2.length - 1]).not.toEqual(day1[day1.length - 1]);
  });
});
