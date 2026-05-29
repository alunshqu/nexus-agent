import type { AgentTeamWorkflow } from "./agent-team.js";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  build: (objective: string) => AgentTeamWorkflow;
};

export const brainstormCouncilTemplate: WorkflowTemplate = {
  id: "brainstorm-council",
  name: "多角色脑暴委员会",
  description: "一次性多角色脑暴任务模板，不是核心 workflow 类型",
  build(objective: string): AgentTeamWorkflow {
    return {
      kind: "task",
      templateId: "brainstorm-council",
      objective,
      roles: [
        { name: "educator", responsibility: "从教育制度、终身成长和人才培养角度提出机会" },
        { name: "scientist", responsibility: "从科学发现、知识生产和验证机制角度提出机会" },
        { name: "teacher", responsibility: "从一线教学、课堂和个体陪伴角度提出机会" },
        { name: "student", responsibility: "从学习体验、动机、身份探索和创造表达角度提出机会" },
        { name: "elder", responsibility: "从晚年尊严、陪伴、记忆和代际连接角度提出机会" },
        { name: "doctor", responsibility: "从连续健康管理、预防医学和医患协同角度提出机会" },
        { name: "entrepreneur", responsibility: "从商业化、MVP、增长和一人公司角度提出机会" },
        { name: "skeptic", responsibility: "专门寻找风险、伪需求、伦理问题和不可落地点" },
        { name: "architect", responsibility: "把高潜想法转成可执行系统架构和路线图" },
      ],
      phases: [
        { name: "observe", owner: "educator", output: "多角色痛点和世界变化观察" },
        { name: "diverge", owner: "scientist", output: "大胆、高潜、跨学科想法池" },
        { name: "challenge", owner: "skeptic", output: "关键反驳、风险和淘汰理由" },
        { name: "converge", owner: "entrepreneur", output: "收敛后的高潜方向排序" },
        { name: "prototype", owner: "architect", output: "首个可构建 MVP 和系统设计" },
        { name: "roadmap", owner: "architect", output: "30/60/90 天落地路线图和最终报告" },
      ],
    };
  },
};

export const generalTaskTemplate: WorkflowTemplate = {
  id: "general-task",
  name: "通用复杂任务",
  description: "当用户目标较复杂但不属于 research/code/kb 时，用于跟踪理解、执行和交付",
  build(objective: string): AgentTeamWorkflow {
    return {
      kind: "task",
      templateId: "general-task",
      objective,
      roles: [
        { name: "planner", responsibility: "理解目标并明确交付物" },
        { name: "executor", responsibility: "推进任务并记录过程" },
        { name: "reviewer", responsibility: "整理交付结果、风险和下一步" },
      ],
      phases: [
        { name: "understand", owner: "planner", output: "目标理解和验收标准" },
        { name: "execute", owner: "executor", output: "执行记录和中间结果" },
        { name: "deliver", owner: "reviewer", output: "最终交付、风险和下一步" },
      ],
    };
  },
};

export const workflowTemplates: WorkflowTemplate[] = [brainstormCouncilTemplate, generalTaskTemplate];

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return workflowTemplates.find(t => t.id === id);
}

export function listWorkflowTemplates(): WorkflowTemplate[] {
  return workflowTemplates;
}
