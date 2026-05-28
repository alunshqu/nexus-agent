# 异步子 Agent 与任务系统设计

## 背景

当前子 agent 是同步阻塞的：主 agent 调用 `agent_run` 后 await 子 agent 完成，期间无法接收新消息。需要改为异步执行，同时解决并发子 agent 的资源冲突问题。

## 核心概念

```
Session (一个 wecom/websocket 对话)
├── Task A: "查今天的科技新闻"
│   ├── sub-agent: web_researcher (后台)
│   └── status: running → done
├── Task B: "重构 auth 模块"
│   ├── sub-agent: coder (后台, cwd=/tmp/task-b-worktree)
│   ├── sub-agent: tester (后台, cwd=/tmp/task-b-worktree)
│   └── status: running
└── 主 agent: 正常接收消息、回复、创建新 task
```

## 数据模型

```typescript
type Task = {
  id: string;
  sessionId: string;        // 归属的 session
  name: string;             // 任务描述
  status: "pending" | "running" | "done" | "failed";
  createdAt: number;
  completedAt?: number;
  result?: string;          // 最终结果摘要
  subAgents: SubAgentRun[]; // 关联的子 agent 执行记录
  cwd?: string;             // 任务级工作目录（隔离用）
};

type SubAgentRun = {
  id: string;
  taskId: string;
  agentName: string;
  task: string;             // 给子 agent 的指令
  status: "running" | "done" | "failed";
  result?: string;
  startedAt: number;
  completedAt?: number;
};
```

## 工具设计

### 新增工具

| 工具 | 说明 |
|------|------|
| `task_create` | 创建一个后台任务，返回 task_id |
| `task_status` | 查询任务状态和子 agent 进度 |
| `task_result` | 获取已完成任务的结果 |
| `task_cancel` | 取消一个正在执行的任务 |
| `task_list` | 列出当前 session 的所有任务 |

### 保留工具

| 工具 | 说明 |
|------|------|
| `agent_run` | 同步执行子 agent（简单任务，不需要后台） |
| `agents_run_parallel` | 同步并行执行多个子 agent |

### 主 agent 调用流程

```
用户: "帮我查一下今天的科技新闻，同时看看竞品最近有什么动态"

主 agent 思考: 这是两个独立的搜索任务，可以后台并行

主 agent 调用: task_create({
  name: "查科技新闻和竞品动态",
  subAgents: [
    { agent: "web_researcher", task: "搜索今天的科技新闻" },
    { agent: "web_researcher", task: "搜索竞品最近动态" }
  ]
})

tool_result: { task_id: "task-001", status: "running", subAgents: 2 }

主 agent 回复: "已经在后台帮你查了，稍后会把结果发给你。"

// 主 agent loop 结束，state.running = false，可以接收新消息
```

### 结果推送

子 agent 完成后，结果通过以下方式送达用户：

1. **主动推送**（推荐）：任务完成后，通过 `sendToWecomChannel(channelId, result)` 直接推送给用户
2. **被动查询**：用户下次发消息时，主 agent 看到有已完成的任务，主动汇报结果
3. **注入 context**：已完成任务的结果作为 system context 注入，主 agent 自然感知

推荐方案 1 + 2 组合：完成时主动推送，下次对话时也能引用。

## 资源隔离

### 问题

多个子 agent 并发执行时可能：
- 编辑同一个文件（冲突）
- 执行互相影响的 shell 命令
- 读到对方写了一半的文件（脏读）

### 解决方案：按任务类型分级

| 类型 | 隔离策略 | 示例 |
|------|---------|------|
| 只读任务 | 无隔离，共享 cwd | web_researcher, 信息查询 |
| 写入任务（同目录） | 串行执行，文件锁 | 同一个项目的多个修改 |
| 写入任务（可隔离） | git worktree / 临时目录 | 独立功能开发 |

### 实现细节

**只读子 agent**：
- `allowedTools` 不包含 `write_file`、`edit_file`、`bash`（或 bash 限制为只读命令）
- 可以安全并行

**写入子 agent**：
- 创建 task 时指定 `isolation: "worktree" | "none"`
- `worktree`：`git worktree add /tmp/task-{id}` 创建独立工作目录
- 子 agent 的 `state.cwd` 设为 worktree 路径
- 完成后主 agent 决定是否 merge

**文件锁（fallback）**：
- 对于 `isolation: "none"` 的写入任务
- `edit_file` / `write_file` 执行前获取文件级锁
- 锁超时自动释放（防死锁）
- 冲突时返回 `is_error: true`，子 agent 可以重试

## 任务生命周期

```
pending → running → done
                  → failed
         → cancelled (用户中断)
```

### 状态转换

1. `task_create` → status = "pending"
2. 子 agent 开始执行 → status = "running"
3. 所有子 agent 完成 → status = "done"，触发结果推送
4. 任何子 agent 失败 → status = "failed"（或部分成功）
5. `task_cancel` → 中断所有子 agent，status = "cancelled"

## 持久化

- Task 存 SQLite（`tasks` 表），重启后恢复 running 状态的任务
- SubAgentRun 存 SQLite（`sub_agent_runs` 表）
- 结果存 SQLite，不放内存

## 与现有系统的关系

| 现有模块 | 变化 |
|---------|------|
| `domain/agent.ts` | 每轮开始检查已完成 task，注入 context |
| `tools/agent.ts` | 新增 `task_create` 等工具，保留 `agent_run` 同步版 |
| `adapters/wecom.ts` | task 完成后调 `sendToWecomChannel` 推送 |
| `infra/session.ts` | Task 和 Session 关联 |
| `prompt.ts` | system prompt 加 task 相关说明 |

## 实现步骤

1. **infra/task.ts** — Task 模型、CRUD、SQLite 持久化
2. **tools/agent.ts** — `task_create`、`task_status`、`task_result`、`task_cancel`、`task_list`
3. **server.ts** — task runner（后台执行子 agent，完成后推送）
4. **domain/agent.ts** — 每轮注入已完成 task 结果
5. **资源隔离** — worktree 创建/清理、文件锁
6. **单元测试** — task 生命周期、并发执行、冲突检测

## 开放问题

1. **task 结果多大？** — 子 agent 可能输出很长的结果，需要截断或摘要
2. **task 超时？** — 复用 `CRON_JOB_TIMEOUT_MS`（30 分钟）还是单独配置？
3. **task 数量限制？** — 同一 session 最多几个并发 task？建议 5 个
4. **worktree 清理时机？** — task 完成后立即清理，还是保留一段时间？
5. **跨 session task？** — 一个 task 能否被多个 session 共享？暂时不需要
