import assert from "node:assert/strict";
import { createAskUserQuestionHook } from "../lib/agent/hooks/built-in.ts";

// 多问答:AskUserQuestion 带多题时「一次下发」(前端一个浮层左右切换),不再逐题弹 N 次浮层。
// 单题保持兼容(纯文本答案),多题结构化(JSON 回填每题)。answer route 不改(答案仍是 string)。
type Ctx = {
  toolName: string;
  input: unknown;
  outputDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveUserQuestion?: (q: any) => Promise<string>;
};

export const askUserMultiTestPromise = (async () => {
  const hook = createAskUserQuestionHook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const before = (c: Ctx) => hook.before!(c as any);

  // mock 交互通道:多题(带 questions)→ 返回 JSON 每题答案;单题 → 纯文本
  const calls: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolve = async (q: any): Promise<string> => {
    calls.push(q);
    if (Array.isArray(q.questions)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return JSON.stringify(Object.fromEntries(q.questions.map((x: any) => [x.question, "答-" + x.question])));
    }
    return "单答-" + q.question;
  };

  const multiInput = { questions: [
    { question: "科目选哪个?", header: "科目" },
    { question: "哪个部门?", header: "维度" },
    { question: "金额确认?", header: "金额" },
  ] };

  // ── A1: 多题「一次下发」——核心:调用次数 = 1(而非逐题 3 次)──
  calls.length = 0;
  const r1 = await before({ toolName: "AskUserQuestion", input: multiInput, outputDir: "/tmp", resolveUserQuestion: resolve });
  assert.equal(calls.length, 1, "A1 FAIL: 多题应一次下发(1 次调用),而非逐题弹");
  assert.equal(r1.action, "allow", "A1 FAIL: 应放行");
  assert.deepEqual(
    (r1 as { input: { answers: Record<string, string> } }).input.answers,
    { "科目选哪个?": "答-科目选哪个?", "哪个部门?": "答-哪个部门?", "金额确认?": "答-金额确认?" },
    "A1 FAIL: 三题答案应正确回填"
  );

  // ── A2: 单题兼容——纯文本答案,不回归 ──
  calls.length = 0;
  const r2 = await before({ toolName: "AskUserQuestion", input: { questions: [{ question: "确认吗?", header: "确认" }] }, outputDir: "/tmp", resolveUserQuestion: resolve });
  assert.equal(calls.length, 1, "A2 FAIL: 单题一次调用");
  assert.equal((r2 as { input: { answers: Record<string, string> } }).input.answers["确认吗?"], "单答-确认吗?", "A2 FAIL: 单题纯文本答案");

  // ── A3: 无交互通道 → deny(提示改用文字问)──
  const r3 = await before({ toolName: "AskUserQuestion", input: multiInput, outputDir: "/tmp" });
  assert.equal(r3.action, "deny", "A3 FAIL: 无 resolveUserQuestion 应 deny");

  // ── A4: 非 AskUserQuestion 工具 → 放行,不干预 ──
  const r4 = await before({ toolName: "Read", input: {}, outputDir: "/tmp", resolveUserQuestion: resolve });
  assert.equal(r4.action, "allow", "A4 FAIL: 其它工具应放行");

  // ── A5: 交互超时/空答(resolve 返空串)→ 降级每题空答,不崩 ──
  calls.length = 0;
  const r5 = await before({ toolName: "AskUserQuestion", input: multiInput, outputDir: "/tmp", resolveUserQuestion: async () => "" });
  assert.equal(r5.action, "allow", "A5 FAIL: 空答应放行");
  assert.equal((r5 as { input: { answers: Record<string, string> } }).input.answers["科目选哪个?"], "", "A5 FAIL: 空答降级为空串");

  console.log("ask-user-multi: 多题一次下发 / 单题兼容 / 无通道deny / 放行 / 空答降级 ✓");
})();
