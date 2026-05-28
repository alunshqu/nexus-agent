import { agentConfig } from "../infra/config.js";

const EMBEDDING_DIM = 384;
const EMBEDDING_API = process.env.EMBEDDING_API_URL; // e.g. "https://api.openai.com/v1/embeddings"
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBEDDING_KEY = process.env.EMBEDDING_API_KEY;

export function getEmbeddingDim(): number {
  return EMBEDDING_API ? 1536 : EMBEDDING_DIM;
}

export async function embed(text: string): Promise<Float32Array> {
  if (EMBEDDING_API) return embedViaAPI(text);
  return embedLocal(text);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (EMBEDDING_API) return embedBatchViaAPI(texts);
  return texts.map(embedLocal);
}

// ── API-based embedding ───────────────────────────────────────────────────────

async function embedViaAPI(text: string): Promise<Float32Array> {
  const results = await embedBatchViaAPI([text]);
  return results[0];
}

async function embedBatchViaAPI(texts: string[]): Promise<Float32Array[]> {
  const apiKey = EMBEDDING_KEY ?? agentConfig.current.apiKey;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(EMBEDDING_API!, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!res.ok) throw new Error(`Embedding API error ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  return json.data.map((d: any) => new Float32Array(d.embedding));
}

// ── Local bag-of-words embedding (zero external dependency) ───────────────────
// Simple but effective for keyword-heavy memory retrieval.
// Uses character n-gram hashing to produce a fixed-size vector.

function embedLocal(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  const normalized = text.toLowerCase().replace(/[^\w一-鿿]/g, " ");
  const tokens = normalized.split(/\s+/).filter(t => t.length > 1);

  for (const token of tokens) {
    // Hash each token and its bigrams into vector positions
    const h1 = hashStr(token) % EMBEDDING_DIM;
    vec[h1] += 1;

    // Character trigrams for sub-word matching
    for (let i = 0; i <= token.length - 3; i++) {
      const trigram = token.slice(i, i + 3);
      const h = hashStr(trigram) % EMBEDDING_DIM;
      vec[h] += 0.5;
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;

  return vec;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
