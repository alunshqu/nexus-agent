import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { saveMemory } from "../memory/store.js";

const PENDING_DIR = path.join(os.homedir(), ".agent", "principles", "pending");

export function maybeIngestUserCorrection(message: string, sessionId: string): { saved: boolean; pendingPath?: string } {
  if (!looksLikePrincipleFeedback(message)) return { saved: false };

  const content = `用户反馈沉淀为准则候选：${message.slice(0, 2000)}`;
  saveMemory(content, "correction", { tags: ["principle-feedback", "runtime-learning"], sessionId, source: "user_explicit" });

  mkdirSync(PENDING_DIR, { recursive: true });
  const file = path.join(PENDING_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ sessionId, message, createdAt: Date.now(), status: "pending_review" }, null, 2), "utf8");
  return { saved: true, pendingPath: file };
}

function looksLikePrincipleFeedback(message: string): boolean {
  return /不应该|你应该|不要|不能|准则|守则|沉淀|经验|流程|机制|后续|评价|反馈|源头/.test(message) && /你|agent|助手|模型|系统|任务|工作/.test(message);
}
