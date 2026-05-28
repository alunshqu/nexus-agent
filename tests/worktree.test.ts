import { describe, it, expect, beforeEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";

// ── Worktree isolation tests ──────────────────────────────────────────────────

const TEST_REPO = path.join(os.tmpdir(), "agent-worktree-test-repo");
const WORKTREE_DIR = path.join(os.tmpdir(), "agent-worktree-test-trees");

// ── Worktree helper functions (mirrors what infra/task.ts will use) ───────────

function createWorktree(repoDir: string, taskId: string): string {
  const branchName = `task/${taskId}`;
  const worktreePath = path.join(WORKTREE_DIR, taskId);
  mkdirSync(WORKTREE_DIR, { recursive: true });
  execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, { cwd: repoDir, stdio: "pipe" });
  return worktreePath;
}

function removeWorktree(repoDir: string, taskId: string): void {
  const worktreePath = path.join(WORKTREE_DIR, taskId);
  if (existsSync(worktreePath)) {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoDir, stdio: "pipe" });
  }
  // Clean up branch
  try { execSync(`git branch -D "task/${taskId}"`, { cwd: repoDir, stdio: "pipe" }); } catch {}
}

function listWorktrees(repoDir: string): string[] {
  const output = execSync("git worktree list --porcelain", { cwd: repoDir, encoding: "utf8" });
  return output.split("\n").filter(l => l.startsWith("worktree ")).map(l => l.slice(9));
}

function isGitRepo(dir: string): boolean {
  try { execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" }); return true; } catch { return false; }
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

function setupTestRepo() {
  rmSync(TEST_REPO, { recursive: true, force: true });
  rmSync(WORKTREE_DIR, { recursive: true, force: true });
  mkdirSync(TEST_REPO, { recursive: true });
  execSync("git init", { cwd: TEST_REPO, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: TEST_REPO, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: TEST_REPO, stdio: "pipe" });
  writeFileSync(path.join(TEST_REPO, "README.md"), "# Test\n");
  execSync("git add . && git commit -m 'init'", { cwd: TEST_REPO, stdio: "pipe" });
}

function cleanupTestRepo() {
  // Remove worktrees first
  try {
    const trees = listWorktrees(TEST_REPO);
    for (const t of trees) {
      if (t !== TEST_REPO) {
        try { execSync(`git worktree remove "${t}" --force`, { cwd: TEST_REPO, stdio: "pipe" }); } catch {}
      }
    }
  } catch {}
  rmSync(TEST_REPO, { recursive: true, force: true });
  rmSync(WORKTREE_DIR, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("worktree isolation", () => {
  beforeEach(() => {
    cleanupTestRepo();
    setupTestRepo();
  });

  it("creates a worktree for a task", () => {
    const worktreePath = createWorktree(TEST_REPO, "task-001");
    expect(existsSync(worktreePath)).toBe(true);
    expect(isGitRepo(worktreePath)).toBe(true);
    expect(existsSync(path.join(worktreePath, "README.md"))).toBe(true);
  });

  it("worktree has its own branch", () => {
    createWorktree(TEST_REPO, "task-002");
    const branch = execSync("git branch --show-current", { cwd: path.join(WORKTREE_DIR, "task-002"), encoding: "utf8" }).trim();
    expect(branch).toBe("task/task-002");
  });

  it("changes in worktree don't affect main repo", () => {
    const worktreePath = createWorktree(TEST_REPO, "task-003");
    writeFileSync(path.join(worktreePath, "new-file.txt"), "hello");
    expect(existsSync(path.join(worktreePath, "new-file.txt"))).toBe(true);
    expect(existsSync(path.join(TEST_REPO, "new-file.txt"))).toBe(false);
  });

  it("two worktrees are isolated from each other", () => {
    const wt1 = createWorktree(TEST_REPO, "task-a");
    const wt2 = createWorktree(TEST_REPO, "task-b");
    writeFileSync(path.join(wt1, "file-a.txt"), "from A");
    writeFileSync(path.join(wt2, "file-b.txt"), "from B");
    expect(existsSync(path.join(wt1, "file-b.txt"))).toBe(false);
    expect(existsSync(path.join(wt2, "file-a.txt"))).toBe(false);
  });

  it("removes a worktree cleanly", () => {
    const worktreePath = createWorktree(TEST_REPO, "task-004");
    expect(existsSync(worktreePath)).toBe(true);
    removeWorktree(TEST_REPO, "task-004");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("lists active worktrees", () => {
    createWorktree(TEST_REPO, "task-x");
    createWorktree(TEST_REPO, "task-y");
    const trees = listWorktrees(TEST_REPO);
    expect(trees.length).toBeGreaterThanOrEqual(3); // main + 2 worktrees
    expect(trees.some(t => t.includes("task-x"))).toBe(true);
    expect(trees.some(t => t.includes("task-y"))).toBe(true);
  });

  it("non-git directory returns false for isGitRepo", () => {
    expect(isGitRepo("/tmp")).toBe(false);
  });
});
