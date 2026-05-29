import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  current: {
    type: "anthropic" as const,
    apiKey: "anthropic-key",
    baseURL: "http://code.casstime.ai",
    model: "claude-opus-4-7",
    activeProviderId: "anthropic",
    providers: [
      { id: "code.casstime.ai", name: "code.casstime.ai", type: "openai" as const, apiKey: "openai-key", baseURL: "http://code.casstime.ai" },
      { id: "openai", name: "openai", type: "openai" as const, apiKey: "openai-key", baseURL: "http://code.casstime.ai/v1" },
      { id: "anthropic", name: "anthropic", type: "anthropic" as const, apiKey: "anthropic-key", baseURL: "http://code.casstime.ai" },
    ],
  },
  provider: { model: "claude-opus-4-7", type: "anthropic" as const },
  applied: [] as any[],
}));

vi.mock("../infra/config.js", () => ({
  agentConfig: state,
  applyConfig: vi.fn((config: any) => {
    state.applied.push(config);
    const active = config.providers.find((p: any) => p.id === config.activeProviderId);
    state.current = { ...config, type: active.type, apiKey: active.apiKey, baseURL: active.baseURL };
    state.provider = { model: config.model, type: active.type };
  }),
  upsertProvider: vi.fn(),
}));

vi.mock("../infra/provider.js", () => ({ fetchModels: vi.fn(async () => ["gpt-5.5"]) }));
vi.mock("../infra/mcp.js", () => ({ addMcpServer: vi.fn(), removeMcpServer: vi.fn(), getMcpStatus: vi.fn(() => []), reconnectAll: vi.fn() }));
vi.mock("../prompt.js", () => ({ invalidateSystemPrompt: vi.fn() }));
vi.mock("../infra/cron.js", () => ({ listCrons: vi.fn(() => []), addCron: vi.fn(), deleteCron: vi.fn(), updateCron: vi.fn(), getCron: vi.fn() }));
vi.mock("../infra/hooks.js", () => ({ reloadHooks: vi.fn() }));
vi.mock("../infra/task.js", () => ({
  createTask: vi.fn(), getTask: vi.fn(), getSessionTasks: vi.fn(() => []), addSubAgent: vi.fn(), cancelTask: vi.fn(),
  getPendingTasks: vi.fn(() => []), getCompletedTasks: vi.fn(() => []), startSubAgent: vi.fn(), completeSubAgent: vi.fn(), failSubAgent: vi.fn(),
}));

beforeEach(() => {
  state.current.activeProviderId = "anthropic";
  state.current.type = "anthropic";
  state.current.apiKey = "anthropic-key";
  state.current.baseURL = "http://code.casstime.ai";
  state.current.model = "claude-opus-4-7";
  state.provider = { model: "claude-opus-4-7", type: "anthropic" };
  state.applied = [];
});

describe("system provider tools", () => {
  it("lists explicit provider IDs so callers can switch accurately", async () => {
    const { executeSystemTool } = await import("../tools/system.js");
    const result = await executeSystemTool("system_list_providers", {});

    expect(result.content).toContain("id=code.casstime.ai");
    expect(result.content).toContain("id=openai");
    expect(result.content).toContain("▶ id=anthropic");
  });

  it("resolves providerId by id or displayed name when switching models", async () => {
    const { executeSystemTool } = await import("../tools/system.js");
    const result = await executeSystemTool("system_set_model", { model: "gpt-5.5", providerId: "openai" });

    expect(result.is_error).not.toBe(true);
    expect(state.current.activeProviderId).toBe("openai");
    expect(state.current.type).toBe("openai");
    expect(result.content).toBe("模型已切换为：gpt-5.5（openai）");
  });

  it("supports provider lookup by name plus type display string", async () => {
    const { executeSystemTool } = await import("../tools/system.js");
    const result = await executeSystemTool("system_set_model", { model: "gpt-5.5", providerId: "code.casstime.ai [openai]" });

    expect(result.is_error).not.toBe(true);
    expect(state.current.activeProviderId).toBe("code.casstime.ai");
    expect(state.current.type).toBe("openai");
  });
});
