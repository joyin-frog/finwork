import assert from "node:assert/strict";
import {
  getSubQuestions,
  isMultiQuestion,
  formatSelection,
  buildAnswer,
  allAnswered,
} from "../app/components/ask-user-multi-state.ts";
import type { AskUserQuestionPayload } from "../app/chat/chat-types.ts";

// 多问答面板逻辑:单题/多题统一取子题、答案合并(多题→JSON 对接后端 parseMultiAnswers)、完成判定。
export const askUserMultiStateTestPromise = (async () => {
  const single: AskUserQuestionPayload = { question: "确认吗?", header: "确认", options: [{ label: "是" }, { label: "否" }] };
  const multi: AskUserQuestionPayload = {
    question: "需要你确认 2 项",
    questions: [
      { question: "科目选哪个?", header: "科目", options: [{ label: "6602.24" }, { label: "6602.09" }] },
      { question: "哪个部门?", header: "维度", multiSelect: true, options: [{ label: "综合部" }, { label: "行政部" }] },
    ],
  };

  // ── getSubQuestions:单题包成 1 元素;多题取 questions[] ──
  assert.equal(getSubQuestions(single).length, 1, "G1 FAIL: 单题→1 子题");
  assert.equal(getSubQuestions(single)[0].question, "确认吗?", "G1 FAIL: 单题子题=自身");
  assert.equal(getSubQuestions(multi).length, 2, "G2 FAIL: 多题→2 子题");
  assert.equal(getSubQuestions(multi)[1].question, "哪个部门?", "G2 FAIL: 第2子题");

  // ── isMultiQuestion:仅 >1 题算多题(1 题走单题路径)──
  assert.equal(isMultiQuestion(single), false, "I1 FAIL: 单题非多题");
  assert.equal(isMultiQuestion(multi), true, "I2 FAIL: 2 题=多题");
  assert.equal(isMultiQuestion({ question: "x", questions: [{ question: "只一题" }] }), false, "I3 FAIL: 1 题不算多题");

  // ── formatSelection:自由输入优先;多选顿号连接;单选取一 ──
  assert.equal(formatSelection(multi.questions![0], ["6602.24"], ""), "6602.24", "F1 FAIL: 单选");
  assert.equal(formatSelection(multi.questions![1], ["综合部", "行政部"], ""), "综合部、行政部", "F2 FAIL: 多选顿号");
  assert.equal(formatSelection(multi.questions![0], ["6602.24"], "手打的"), "手打的", "F3 FAIL: 自由输入优先");

  // ── buildAnswer:单题→纯文本;多题→JSON{问题:答案}(对接后端 parseMultiAnswers)──
  assert.equal(buildAnswer(getSubQuestions(single), ["是"]), "是", "B1 FAIL: 单题纯文本");
  const merged = buildAnswer(getSubQuestions(multi), ["6602.24", "综合部"]);
  assert.deepEqual(JSON.parse(merged), { "科目选哪个?": "6602.24", "哪个部门?": "综合部" }, "B2 FAIL: 多题合并 JSON");

  // ── allAnswered:全部题作答才算完成(末题「提交」启用判据)──
  assert.equal(allAnswered(["6602.24", "综合部"], 2), true, "A1 FAIL: 全答→完成");
  assert.equal(allAnswered(["6602.24", ""], 2), false, "A2 FAIL: 缺一题→未完成");
  assert.equal(allAnswered(["6602.24"], 2), false, "A3 FAIL: 少答→未完成");

  console.log("ask-user-multi-state: 取子题/多题判定/选择格式化/答案合并/完成判定 ✓");
})();
