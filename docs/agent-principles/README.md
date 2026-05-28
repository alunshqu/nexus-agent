# Agent Principles

本目录说明 agent 的运行时准则系统。准则不是普通文档，而是 `principles/` 下的机器可读规则：每轮 LLM 调用前，runtime 会根据任务情景主动选择适用准则，并以短卡片形式注入 `<active_principles>`。

## 核心流程

1. 识别用户任务情景，例如 code_change、bug_fix、runtime_issue、feedback_learning。
2. 通过 `selectPrinciplesForTask` 主动选择必须遵守的准则，不等待用户显式说出“源头修”。
3. 通过 `renderActivePrinciplesForPrompt` 注入本轮上下文。
4. 执行过程记录 evidence：工具调用、文件读取/修改、测试命令、commit 等。
5. 回复结束前通过 `evaluatePrinciples` 生成 `principle_eval` trace。
6. 用户纠正类反馈通过 `maybeIngestUserCorrection` 写入 correction memory 和 pending principle。

## 第一批 mandatory principles

- `P-PRINCIPLE-ACTIVE-RETRIEVAL`：每轮任务主动检索适用准则。
- `P-ENGINEERING-SOURCE-FIX`：修改、bug、异常、优化、纠错类任务优先源头修复。
- `P-RUNTIME-GUARDRAIL`：LLM output、工具结果、外部输入都不可信，runtime 层必须兜底。
- `P-REGRESSION-TEST`：已发生问题必须新增或更新 regression test。
- `P-FEEDBACK-LEARNING-LOOP`：用户纠正必须进入学习闭环。
- `P-NO-PROMPT-ONLY-FIX`：系统性问题禁止只靠 prompt 修复。

## 原则

文档只用于审查和解释；真正生效的是 `principles/*.ts` 的 runtime 选择、注入和评价机制。
