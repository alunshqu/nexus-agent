import type { AgentTeamWorkflow } from "./agent-team.js";
import type { WorkflowRun } from "./runner.js";

export type BrainstormReport = {
  title: string;
  markdown: string;
};

export function generateBrainstormReport(run: WorkflowRun): BrainstormReport {
  if (run.workflow.templateId !== "brainstorm-council") throw new Error("generateBrainstormReport requires brainstorm-council template workflow");
  const objective = run.workflow.objective;
  const outputs = Object.fromEntries(run.phases.map(p => [p.name, p.output ?? ""]));
  const title = `多角色脑暴最终报告：${objective}`;
  const markdown = [
    `# ${title}`,
    "",
    "## 0. 执行摘要",
    "这次脑暴的核心结论是：不要只构建一个聊天机器人，而要构建一个能长期组织人类目标、记忆、任务、关系和创造力的 **LifeOS / 个人 AI 委员会**。它的颠覆性不在于回答问题，而在于让普通人拥有过去只有机构、团队和专家网络才具备的持续执行力。",
    "",
    "最值得优先构建的方向：",
    "",
    "1. **LifeOS：个人 AI 委员会** — 每个人背后的长期私人团队。",
    "2. **一人公司操作系统** — 让个体拥有公司级执行力。",
    "3. **人生学习与天赋雷达** — 让教育围绕人而不是围绕课程。",
    "4. **生命连续管理系统** — 从看病变成预防、陪伴和连续健康决策。",
    "5. **记忆与代际连接系统** — 保存人的故事、经验、关系和尊严。",
    "",
    "## 1. 多角色观察",
    outputs.observe || fallbackObserve(objective),
    "",
    "## 2. 大胆想法池",
    outputs.diverge || fallbackDiverge(),
    "",
    "## 3. 怀疑者挑战",
    outputs.challenge || fallbackChallenge(),
    "",
    "## 4. 收敛排序",
    outputs.converge || fallbackConverge(),
    "",
    "## 5. 推荐 MVP：LifeOS 个人 AI 委员会",
    outputs.prototype || fallbackPrototype(),
    "",
    "## 6. 30/60/90 天路线图",
    outputs.roadmap || fallbackRoadmap(),
    "",
    "## 7. 最终判断",
    "如果要做一个足够激动人心、又能从当前工程能力自然生长出来的东西，首选不是泛泛的 Agent 平台，而是 **以人为中心的 LifeOS**。它可以先服务一个人，再服务一个家庭、一间教室、一家小公司、一个社区，最终成为连接教育、健康、职业、创造和记忆的个人基础设施。",
  ].join("\n");
  return { title, markdown };
}

export function createBrainstormPhaseOutput(workflow: AgentTeamWorkflow, phaseName: string, previousOutputs: Record<string, string>): string {
  if (workflow.templateId !== "brainstorm-council") return `阶段 ${phaseName} 已完成。`;
  const objective = workflow.objective;
  switch (phaseName) {
    case "observe": return fallbackObserve(objective);
    case "diverge": return fallbackDiverge();
    case "challenge": return fallbackChallenge();
    case "converge": return fallbackConverge();
    case "prototype": return fallbackPrototype();
    case "roadmap": return fallbackRoadmap();
    default: return `阶段 ${phaseName} 已完成。前序输出：${Object.keys(previousOutputs).join(", ")}`;
  }
}

function fallbackObserve(objective: string): string {
  return [
    `围绕「${objective}」，多角色形成了一个共同判断：AI 的下一阶段价值不是替人说话，而是替人组织复杂生活。`,
    "",
    "- 教育家：学校正在从统一课程走向个体成长路线，最缺的是持续理解每个人的系统。",
    "- 老师：一线教育最大的瓶颈是精力被批改、备课、行政吞噬，老师需要 AI 助教团队。",
    "- 学生：学生真正想要的是被理解、被发现，而不是被更多题目包围。",
    "- 科学家：知识爆炸让人类个体难以跨领域综合，科研需要假设生成与反驳机制。",
    "- 医生：医疗不能只在门诊发生，健康需要长期连续的个人上下文。",
    "- 老人：晚年问题不仅是照护，更是尊严、记忆、连接和不被遗忘。",
    "- 创业者：未来大量个人会希望拥有小团队级别的执行能力。",
  ].join("\n");
}

function fallbackDiverge(): string {
  return [
    "高潜想法池：",
    "",
    "1. LifeOS：长期陪伴人的个人操作系统。",
    "2. AI 个人委员会：由导师、医生、教练、财务、创造者、反对者组成的常驻团队。",
    "3. 一人公司 OS：把市场、产品、工程、增长、客服、财务变成可调用 agent。",
    "4. 天赋雷达：长期观察人的兴趣、心流、表达、创造和抗挫模式。",
    "5. 生命连续管理：整合健康数据、病史、生活方式和风险预测。",
    "6. 记忆博物馆：把老人、家庭、创作者的一生沉淀成可交互记忆。",
    "7. 科学发现工厂：文献、假设、反驳、实验设计、论文写作多 agent 闭环。",
  ].join("\n");
}

function fallbackChallenge(): string {
  return [
    "怀疑者提出的关键挑战：",
    "",
    "- 太大：LifeOS 容易变成无边界愿景，必须从一个高频刚需切入。",
    "- 太虚：如果不能每天产生可执行结果，用户会快速流失。",
    "- 隐私风险：健康、关系、财务、记忆数据高度敏感，必须本地优先、可删除、可导出。",
    "- 过度依赖：系统不能替用户做价值判断，只能辅助澄清和执行。",
    "- 信任问题：所有建议必须有依据、可追溯、可反驳。",
    "- 商业化风险：不要一开始服务所有人，先服务高动机个人创作者/创业者。",
  ].join("\n");
}

function fallbackConverge(): string {
  return [
    "收敛后的优先级：",
    "",
    "### P0：LifeOS 个人 AI 委员会",
    "原因：最能承载长期记忆、workflow、多 agent 协作，也是当前工程最自然的演进方向。",
    "",
    "### P1：一人公司操作系统",
    "原因：商业闭环更清晰，用户愿意为执行力付费，可作为 LifeOS 的职业/创造模块。",
    "",
    "### P2：天赋雷达与个人学习学院",
    "原因：社会价值巨大，但需要更长周期数据积累。",
    "",
    "### P3：老人记忆与陪伴系统",
    "原因：温柔且重要，但交互硬件、家庭协作和医疗伦理要求更高。",
  ].join("\n");
}

function fallbackPrototype(): string {
  return [
    "MVP 名称：**LifeOS Council**",
    "",
    "核心不是聊天，而是一次次结构化 council workflow：",
    "",
    "- 输入：用户当前目标、困惑、项目、健康/学习/职业上下文。",
    "- 多角色：导师、执行官、怀疑者、研究员、产品经理、健康教练、记录者。",
    "- 输出：一份可执行决策报告 + 下一步任务列表 + 长期记忆更新。",
    "",
    "MVP 必备功能：",
    "",
    "1. `/workflow template brainstorm-council <主题>` 生成多角色脑暴。",
    "2. 每次脑暴都保存 run/events/artifacts。",
    "3. 输出最终 Markdown 报告。",
    "4. 用户可以把报告转成任务、定时复盘、记忆。",
    "5. 每个角色观点可追溯、可反驳、可重新投票。",
  ].join("\n");
}

function fallbackRoadmap(): string {
  return [
    "### 30 天：可用原型",
    "- 支持 brainstorm-council 任务模板。",
    "- 内置多角色 council。",
    "- 输出最终报告 artifact。",
    "- 支持命令/API 创建、运行、查看。",
    "",
    "### 60 天：个人长期上下文",
    "- 接入 memory，把用户目标、偏好、项目、重要决策长期保存。",
    "- 增加 weekly review / daily planning workflow。",
    "- 把报告中的行动项转成 task。",
    "",
    "### 90 天：LifeOS Beta",
    "- 多个 council 模板：创业、学习、健康、关系、科研、人生决策。",
    "- 支持用户自定义角色。",
    "- 支持 artifact 面板和版本对比。",
    "- 引入隐私边界、导出、删除和本地优先策略。",
  ].join("\n");
}
