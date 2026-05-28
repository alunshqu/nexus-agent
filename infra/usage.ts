import type { TokenUsage } from "./provider.js";

export function formatTokenUsage(usage?: TokenUsage): string {
  if (!usage) return "Token 使用：无统计";
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const total = input + output;
  const parts = [
    `Token 使用：input ${formatNumber(input)}，output ${formatNumber(output)}，total ${formatNumber(total)}`,
  ];
  if (cacheCreate || cacheRead) {
    parts.push(`cache 创建 ${formatNumber(cacheCreate)}，cache 命中 ${formatNumber(cacheRead)}`);
  }
  return parts.join("；");
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
