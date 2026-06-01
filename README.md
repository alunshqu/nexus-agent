# nexus-agent

一个全能型 AI Agent 平台。它不只是回答问题，而是拥有真实可执行的工具，能直接读写文件、执行命令、调用浏览器、检索网络、委托子 agent、编排多角色 workflow，并把每一轮交互沉淀为可复用的记忆和准则。

核心设计目标：

- **直接行动**：能用工具查到、做到的事情，先做再说，而不是给建议。
- **可观测**：每轮 LLM 调用、工具执行、token 用量都进入 trace，可在 Web UI 回放。
- **会学习**：用户的纠正会进入"反馈学习闭环"，沉淀为记忆和运行时准则，后续由任务情景自动触发。
- **缓存友好**：系统提示与对话前缀做了 prompt cache 稳定性设计，动态内容放在缓存前缀之外。

## 特性一览

| 能力 | 说明 |
| --- | --- |
| Agent 主循环 | 多轮 tool-use 循环,支持工具去重、超时、最大迭代保护、流式输出 |
| 多 Provider | Anthropic 与 OpenAI 兼容接口,可热切换 provider 与模型 |
| 工具集 | 文件系统、shell、网络搜索/抓取、浏览器自动化(CDP)、系统管理 |
| 子 Agent | `agent_run` 同步委托、`agents_run_parallel` 并行委托独立子任务 |
| Workflow | 多角色多阶段编排(脑暴委员会、研究报告、代码报告、通用任务等) |
| 记忆系统 | 基于 SQLite + sqlite-vec 的向量记忆,自动抽取、检索、注入上下文 |
| 准则系统 | 运行时按任务情景主动选择准则并注入,回复后评价是否被遵守 |
| 技能(Skills) | 结构化操作手册,在系统提示中按 token 预算渲染 |
| MCP | 接入 Model Context Protocol 服务器,工具自动并入工具集 |
| 定时任务 | cron 风格调度,到点自动执行并把结果推送到渠道 |
| Hooks | 在 `before_message`/`after_tool`/`on_done`/`on_error` 触发 shell 命令 |
| 企业微信 | 通过 WeCom AiBot 接入,支持文本、媒体收发与进度推送 |
| Web UI | 聊天、trace 回放、设置、MCP、监控、agents、skills 多个页面 |

## 技术栈

- 运行时:Node.js + TypeScript(ESM,`tsx` 直接运行,无构建步骤)
- LLM SDK:`@anthropic-ai/sdk`、`openai`
- 存储:`better-sqlite3` + `sqlite-vec`(向量记忆)
- 协议:`@modelcontextprotocol/sdk`(MCP)、`@wecom/aibot-node-sdk`(企业微信)
- 浏览器:`chrome-remote-interface`(Chrome DevTools Protocol)
- 测试:`vitest`

<!-- APPEND-MARKER -->

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制示例并填入你的密钥(项目读取根目录与运行目录下的 `.env`):

```bash
cp .env.example .env
```

最少需要配置一个 LLM provider。可以走环境变量,也可以走 `~/.claude/settings.json` 里的 `ANTHROPIC_*`(config 会自动读取),或在 Web UI 的设置页里填。

### 3. 启动

```bash
npm start          # 等价于 npx tsx server.ts
```

默认监听 `http://localhost:8080`。打开浏览器即可进入聊天界面。

### 4. 验证

```bash
curl http://localhost:8080/health         # { ok: true, model: ... }
npm run typecheck                          # 类型检查
npm test                                   # 运行 vitest 测试套件
```

## 配置

环境变量(均为可选,缺省走默认值或自动探测):

### Provider / 模型

| 变量 | 说明 |
| --- | --- |
| `PROVIDER_TYPE` | `anthropic`(默认)或 `openai` |
| `PROVIDER_API_KEY` | LLM API key,缺省时回退到 `~/.claude/settings.json` |
| `PROVIDER_BASE_URL` | 自定义 API 端点(代理/兼容网关) |
| `ANTHROPIC_MODEL` | 模型名 |
| `PROVIDER_MAX_RETRIES` / `PROVIDER_RETRY_BASE_MS` / `PROVIDER_RETRY_MAX_DELAY_MS` | 重试策略(指数退避 + 抖动,尊重 `Retry-After`) |

### 网络搜索(按优先级回退)

`web_search` 依次尝试:AnySearch → Tavily → Brave → DuckDuckGo(无 key 兜底)。

| 变量 | 说明 |
| --- | --- |
| `ANY_SEARCH_KEY` / `ANYSEARCH_API_KEY` | AnySearch |
| `TAVILY_API_KEY` | Tavily |
| `BRAVE_SEARCH_API_KEY` | Brave Search |

### 记忆(向量检索)

| 变量 | 说明 |
| --- | --- |
| `EMBEDDING_API_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | embedding 服务配置 |
| `MAX_MEMORY_TOKENS` | 注入上下文的记忆 token 预算 |

### 企业微信

| 变量 | 说明 |
| --- | --- |
| `WECOM_BOT_ID` | 机器人 ID |
| `WECOM_SECRET` | 机器人密钥(未配置则跳过 WeCom 接入) |

### 运行时调优

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口(默认 8080) |
| `MAX_AGENT_ITERATIONS` | 单轮最大工具迭代数(默认 50) |
| `TOOL_TIMEOUT_MS` | 单个工具超时(默认 5 分钟) |
| `TOOL_DEFER_LOADING` | 设为 `1` 启用工具延迟加载(配合 `tool_search`) |
| `PRINCIPLES_EVAL` | 设为 `0` 关闭准则观测性选择与评价 |
| `LOG_LEVEL` | 日志级别 |

> MCP 服务器在 `.mcp.json` 中配置;`~/.agent/` 目录下持久化 provider 配置、agents、skills、记忆库等。

## 架构

```
server.ts                  HTTP + WebSocket 入口,启动 MCP/cron/hooks/wecom
├── domain/                核心循环
│   ├── agent.ts           runAgent:tool-use 主循环、去重、超时、trace
│   ├── context.ts         消息裁剪、token 估算、prompt cache 断点
│   ├── cold-start.ts      会话冷启动压缩
│   └── workflow-auto.ts   自动判定是否走 workflow
├── infra/                 基础设施
│   ├── provider.ts        Anthropic/OpenAI 抽象 + 重试
│   ├── config.ts          可热切换的 provider 配置单例
│   ├── session.ts         会话持久化与修复
│   ├── mcp.ts             MCP 连接与健康检查
│   ├── cron.ts            定时任务调度
│   ├── hooks.ts           生命周期 shell hook
│   ├── trace.ts           调用链 trace
│   └── ...                metrics / usage / dns-fix / worktree
├── tools/                 工具实现(文件、shell、web、browser、agent、system)
├── agents/                子 agent 模板注册表
├── workflows/             多角色多阶段编排
├── memory/                SQLite + sqlite-vec 向量记忆
├── principles/            运行时准则:选择、注入、评价、反馈
├── skills/                结构化技能手册
├── adapters/              wecom / websocket / http / im 接入层
├── routes/                api.ts(REST)+ pages.ts(静态页)
└── *.html                 Web UI:chat / trace / settings / mcp / monitor / agents / skills
```

### Agent 主循环

`domain/agent.ts` 的 `runAgent` 是核心:

1. 组装工具集(本地工具 + 浏览器 + 记忆 + MCP),按需做延迟加载。
2. 修复会话消息(保证每个 `tool_use` 都有对应 `tool_result`)。
3. 按任务情景选择适用准则、检索相关记忆,作为缓存前缀外的 suffix 注入。
4. 进入迭代循环:流式调用 provider → 落盘 assistant 消息 → 执行工具 → 落盘 tool_result。
5. 工具调用按签名去重,执行有超时保护,每步进入 trace。
6. `end_turn` 时结束,评价准则、后台抽取记忆、触发 `on_done` hook。

### Prompt Cache 策略

系统提示中的准则、技能、agent 注册表都作为**静态块**进入缓存前缀;而 cwd、日期、检索到的记忆等**每轮变化的内容**放在最后一条消息断点**之后**,从而不破坏缓存命中。详见 `domain/context.ts` 与 `prompt.ts` 中的注释。

## 工具集

- **文件系统**:`read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep`
- **Shell**:`bash`、`set_cwd`
- **网络**:`web_search`、`web_fetch`
- **浏览器**(需 Chrome `--remote-debugging-port=9222`):`browser_navigate`、`browser_screenshot`、`browser_get_content`、`browser_click`、`browser_type`、`browser_eval`、`browser_tabs`、`browser_new_tab`
- **子 Agent**:`agent_run`、`agents_run_parallel`、`agent_create`/`agent_list`/`agent_delete`
- **记忆**:`memory_save`、`memory_search`、`memory_list`、`memory_update`、`memory_delete`
- **系统**:`system_set_model`、`system_list_providers`/`system_list_models`、`system_mcp_*`、`cron_*`、`hook_*`、`task_*`、`send_media`

## Web UI

| 路径 | 页面 |
| --- | --- |
| `/` 或 `/chat` | 聊天 |
| `/trace` | 调用链 trace 回放 |
| `/monitor` | 运行监控、指标 |
| `/settings` | provider / 模型设置 |
| `/mcp` | MCP 服务器管理 |
| `/agents` | 子 agent 模板管理 |
| `/skills` | 技能管理 |
| `/health`、`/health/ready` | 健康检查 |

## 测试

```bash
npm test            # 全量 vitest
npm run typecheck   # tsc --noEmit
```

测试覆盖主循环、工具装配/去重、上下文裁剪、provider 重试、准则运行时、workflow 编排、记忆、会话修复等(`tests/` 下 40+ 个用例)。

## 部署

`restart-when-idle.sh` 提供了一个"空闲时才重启"的脚本(配合 pm2),只有当没有会话在运行时才执行 `pm2 restart nexus-agent`,避免打断进行中的任务:

```bash
./restart-when-idle.sh
```

## 安全说明

- 所有工具输出(文件内容、命令结果、网页内容)都被视为不可信数据;其中看似指令的内容会被忽略。
- 高风险操作(删除数据、推送代码、修改生产配置、发送消息)会先告知影响再执行。
- 密钥不在回复中明文展示;`.env` 与 `~/.agent/` 已被 `.gitignore` 排除。


