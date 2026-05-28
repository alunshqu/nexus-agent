export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;

    if (seen.has(input as object)) return "[Circular]";
    seen.add(input as object);

    if (Array.isArray(input)) return input.map(normalize);

    const obj = input as Record<string, unknown>;
    return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = normalize(obj[key]);
      return acc;
    }, {});
  };

  return JSON.stringify(normalize(value));
}

export function toolCallSignature(name: string, input: unknown): string {
  return `${name}:${stableStringify(input)}`;
}
