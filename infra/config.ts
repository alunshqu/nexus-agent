import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { createProvider, type Provider } from "./provider.js";
import { createLogger } from "./logger.js";

const logger = createLogger("config");

function loadClaudeSettings(): { env: Record<string, string> } {
  try {
    const p = path.join(os.homedir(), ".claude", "settings.json");
    if (!existsSync(p)) return { env: {} };
    return { env: JSON.parse(readFileSync(p, "utf8")).env ?? {} };
  } catch (error) {
    logger.warn("claude_settings_load_failed", { error: error instanceof Error ? error.message : String(error) });
    return { env: {} };
  }
}

const CONFIG_PATH = path.join(os.homedir(), ".agent", "config.json");

export type ProviderProfile = {
  id: string;
  name: string;
  type: "anthropic" | "openai";
  apiKey?: string;
  baseURL?: string;
  models?: string[];
  modelsFetchedAt?: number;
};

export type AgentConfig = {
  type: "anthropic" | "openai";
  apiKey?: string;
  baseURL?: string;
  model?: string;
  activeProviderId?: string;
  providers?: ProviderProfile[];
};

function defaultConfig(): AgentConfig {
  const settings = loadClaudeSettings();
  const type = (process.env.PROVIDER_TYPE as any) ?? "anthropic";
  const apiKey = process.env.PROVIDER_API_KEY ?? settings.env.ANTHROPIC_AUTH_TOKEN ?? settings.env.ANTHROPIC_API_KEY;
  const baseURL = process.env.PROVIDER_BASE_URL ?? settings.env.ANTHROPIC_BASE_URL;
  const model = process.env.ANTHROPIC_MODEL;
  const id = "default";
  return {
    type,
    apiKey,
    baseURL,
    model,
    activeProviderId: id,
    providers: [{ id, name: defaultProviderName(type, baseURL), type, apiKey, baseURL }],
  };
}

function normalizeConfig(config: AgentConfig): AgentConfig {
  const providers = (config.providers?.length ? config.providers : [{
    id: config.activeProviderId ?? "default",
    name: defaultProviderName(config.type, config.baseURL),
    type: config.type,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  }]).map(p => ({ ...p, id: p.id || randomUUID(), name: p.name || defaultProviderName(p.type, p.baseURL) }));

  const activeProviderId = config.activeProviderId ?? providers[0]?.id;
  const active = providers.find(p => p.id === activeProviderId) ?? providers[0];
  return {
    ...config,
    type: active?.type ?? config.type,
    apiKey: active?.apiKey ?? config.apiKey,
    baseURL: active?.baseURL ?? config.baseURL,
    model: config.model,
    activeProviderId: active?.id ?? activeProviderId,
    providers,
  };
}

function loadConfig(): AgentConfig {
  const defaults = defaultConfig();
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return normalizeConfig({ ...defaults, ...saved });
    }
  } catch (error) {
    logger.warn("load_failed", { path: CONFIG_PATH, error: error instanceof Error ? error.message : String(error) });
  }
  return normalizeConfig(defaults);
}

export function saveConfig(config: AgentConfig) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(normalizeConfig(config), null, 2), "utf8");
}

// Mutable singleton — hot-reloadable
export const agentConfig: { current: AgentConfig; provider: Provider } = (() => {
  const current = loadConfig();
  return { current, provider: createProvider(current) };
})();

export function applyConfig(config: AgentConfig) {
  const normalized = normalizeConfig(config);
  agentConfig.current = normalized;
  agentConfig.provider = createProvider(normalized);
  saveConfig(normalized);
  logger.info("provider_reloaded", { type: normalized.type, model: agentConfig.provider.model, activeProviderId: normalized.activeProviderId });
}

export function resetConfig() {
  const config = defaultConfig();
  agentConfig.current = config;
  agentConfig.provider = createProvider(config);
  try {
    unlinkSync(CONFIG_PATH);
  } catch (error) {
    logger.warn("reset_unlink_failed", { path: CONFIG_PATH, error: error instanceof Error ? error.message : String(error) });
  }
  logger.info("reset_to_defaults", { type: config.type, model: agentConfig.provider.model });
}

export function upsertProvider(profile: Partial<ProviderProfile> & Pick<ProviderProfile, "type">): ProviderProfile {
  const providers = [...(agentConfig.current.providers ?? [])];
  const id = profile.id ?? randomUUID();
  const idx = providers.findIndex(p => p.id === id);
  const next: ProviderProfile = {
    ...(idx >= 0 ? providers[idx] : {}),
    id,
    name: profile.name || defaultProviderName(profile.type, profile.baseURL),
    type: profile.type,
    apiKey: profile.apiKey,
    baseURL: profile.baseURL,
    models: profile.models ?? (idx >= 0 ? providers[idx].models : undefined),
    modelsFetchedAt: profile.modelsFetchedAt ?? (idx >= 0 ? providers[idx].modelsFetchedAt : undefined),
  };
  if (idx >= 0) providers[idx] = next;
  else providers.push(next);
  applyConfig({ ...agentConfig.current, providers, activeProviderId: agentConfig.current.activeProviderId ?? id });
  return next;
}

export function cacheProviderModels(providerId: string, models: string[]) {
  const providers = [...(agentConfig.current.providers ?? [])];
  const idx = providers.findIndex(p => p.id === providerId);
  if (idx < 0) return;
  providers[idx] = { ...providers[idx], models, modelsFetchedAt: Date.now() };
  applyConfig({ ...agentConfig.current, providers });
}

export function getConfigForClient(): AgentConfig & { model: string } {
  return { ...agentConfig.current, model: agentConfig.provider.model };
}

function defaultProviderName(type: "anthropic" | "openai", baseURL?: string): string {
  if (type === "anthropic") return baseURL ? `Anthropic (${baseURL})` : "Anthropic";
  if (!baseURL || baseURL.includes("openai.com")) return "OpenAI";
  try { return new URL(baseURL).host; } catch { return baseURL; }
}
