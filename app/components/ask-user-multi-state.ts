/**
 * 多问答面板逻辑(纯函数,便于测试)。
 *
 * 汇总确认时一次下发多题,面板左右切换逐题作答;单题走原路径。
 * 多题提交合并为 JSON{问题文本: 答案},对接后端 hooks/built-in.ts 的 parseMultiAnswers。
 */
import type { AskUserQuestionPayload } from "@/app/chat/chat-types";

export type SubQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

/** 取子题:多题用 questions[];单题(无 questions)包成单元素数组,统一处理。 */
export function getSubQuestions(payload: AskUserQuestionPayload): SubQuestion[] {
  if (Array.isArray(payload.questions) && payload.questions.length > 0) {
    return payload.questions;
  }
  return [{ question: payload.question, header: payload.header, multiSelect: payload.multiSelect, options: payload.options }];
}

/** 是否多题(>1):决定面板是否分页 + 提交格式。 */
export function isMultiQuestion(payload: AskUserQuestionPayload): boolean {
  return Array.isArray(payload.questions) && payload.questions.length > 1;
}

/** 单题选择 → 答案字符串:自由输入优先,多选顿号,单选取一。 */
export function formatSelection(sub: SubQuestion, selected: string[], custom: string): string {
  const c = custom.trim();
  if (c) return c;
  return selected.join(sub.multiSelect ? "、" : "");
}

/** 合并各题答案为提交串:单题→纯文本;多题→JSON{问题:答案}。 */
export function buildAnswer(subs: SubQuestion[], answers: string[]): string {
  if (subs.length <= 1) return answers[0] ?? "";
  const map: Record<string, string> = {};
  subs.forEach((s, i) => {
    map[s.question] = answers[i] ?? "";
  });
  return JSON.stringify(map);
}

/** 全部题已作答(末题「提交」启用判据)。 */
export function allAnswered(answers: string[], count: number): boolean {
  if (answers.length < count) return false;
  return answers.slice(0, count).every((a) => a != null && a.trim().length > 0);
}
