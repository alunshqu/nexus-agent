import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { createLogger } from "./logger.js";

const logger = createLogger("worktree");
const WORKTREE_BASE = path.join(os.tmpdir(), "agent-worktrees");

export function createWorktree(repoDir: string, taskId: string): string | null {
  if (!isGitRepo(repoDir)) {
    logger.warn("not_git_repo", { repoDir });
    return null;
  }
  const branchName = `task/${taskId}`;
  const worktreePath = path.join(WORKTREE_BASE, taskId);
  mkdirSync(WORKTREE_BASE, { recursive: true });
  try {
    execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, { cwd: repoDir, stdio: "pipe" });
    logger.info("worktree_created", { taskId, worktreePath, branch: branchName });
    return worktreePath;
  } catch (error) {
    logger.error("worktree_create_failed", error, { taskId, repoDir });
    return null;
  }
}

export function removeWorktree(repoDir: string, taskId: string): void {
  const worktreePath = path.join(WORKTREE_BASE, taskId);
  if (!existsSync(worktreePath)) return;
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoDir, stdio: "pipe" });
    logger.info("worktree_removed", { taskId });
  } catch (error) {
    logger.error("worktree_remove_failed", error, { taskId });
  }
  try { execSync(`git branch -D "task/${taskId}"`, { cwd: repoDir, stdio: "pipe" }); } catch {}
}

export function isGitRepo(dir: string): boolean {
  try { execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" }); return true; } catch { return false; }
}

export function getWorktreePath(taskId: string): string {
  return path.join(WORKTREE_BASE, taskId);
}
