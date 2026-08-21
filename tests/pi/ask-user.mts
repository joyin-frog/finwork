import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFinworkBuiltinTools } from "../../lib/agent/pi/builtin-tools.ts";
import {
  needsStructuredQuestionRepair,
  wrapQuestionResolver,
} from "../../lib/agent/pi/agent-service.ts";
import { alignPendingQuestionContent } from "../../lib/agent/production-turn.ts";
import type { AgentQuestion } from "../../lib/agent/contracts.ts";
import type { AgentRuntimeEvent } from "../../lib/agent/runtime-events.ts";

const root = mkdtempSync(path.join(tmpdir(), "finwork-pi-ask-user-"));
const roots = { readRoot: root, writeRoot: root };

// 无交互 resolver 时不能向模型承诺一个没人接听的工具。
const nonInteractiveTools = await createFinworkBuiltinTools(roots);
assert.equal(
  nonInteractiveTools.some((tool) => tool.name === "AskUserQuestion"),
  false,
  "无交互 resolver 时不应注册 AskUserQuestion",
);

const emitted: AgentRuntimeEvent[] = [];
const received: AgentQuestion[] = [];
const wrapped = wrapQuestionResolver(async (question) => {
  received.push(question);
  return "2026年7月";
}, (event) => emitted.push(event));
assert.ok(wrapped, "交互 resolver 应成功包装");

const tools = await createFinworkBuiltinTools(roots, { resolveUserQuestion: wrapped });
const ask = tools.find((tool) => tool.name === "AskUserQuestion");
assert.ok(ask, "Pi 主 Agent 应注册模型可调用的 AskUserQuestion");
const schema = ask.parameters as { properties?: Record<string, unknown>; required?: string[] };
assert.ok(schema.properties?.questions, "AskUserQuestion schema 应暴露 questions");
assert.ok(schema.required?.includes("questions"), "questions 应为必填参数");

const single = await ask.execute(
  "ask-single",
  { questions: [{ question: "请提供分析期间", header: "分析期间" }] },
  undefined,
  undefined,
  {} as never,
);
assert.equal(received.length, 1, "单题只应等待一次用户回答");
assert.equal(received[0].question, "请提供分析期间");
assert.equal(single.content[0]?.type, "text");
assert.equal(single.content[0]?.type === "text" ? single.content[0].text : "", "2026年7月");
assert.deepEqual(
  emitted.map((event) => event.type),
  ["ask_user", "ask_user_answered"],
  "实时提问必须按顺序发出 ask_user 与 ask_user_answered",
);

const emittedBeforeInventedPeriod = emitted.length;
await assert.rejects(
  () => ask.execute(
    "ask-invented-period",
    {
      questions: [{
        question: "请提供缺少的分析期间",
        options: [{ label: "2026年8月" }, { label: "2026年7月" }],
      }],
    },
    undefined,
    undefined,
    {} as never,
  ),
  (error: unknown) => error instanceof Error && error.name === "InventedQuestionOptionError",
  "缺失期间不得用运行时日期编造候选项",
);
assert.equal(emitted.length, emittedBeforeInventedPeriod, "非法候选项必须在等待用户前被拒绝");

await assert.rejects(
  () => ask.execute(
    "ask-invented-period-in-question",
    {
      questions: [{
        question: "请提供缺少的分析期间，例如 2026年7月或2026年1—7月",
      }],
    },
    undefined,
    undefined,
    {} as never,
  ),
  (error: unknown) => error instanceof Error && error.name === "InventedQuestionOptionError",
  "问题正文也不得夹带模型编造的具体日期示例",
);
assert.equal(emitted.length, emittedBeforeInventedPeriod, "非法问题正文必须在等待用户前被拒绝");

await ask.execute(
  "ask-neutral-period",
  {
    questions: [{
      question: "请提供缺少的分析期间",
      options: [{ label: "手动输入", description: "填写需要分析的期间" }],
    }],
  },
  undefined,
  undefined,
  {} as never,
);

await assert.rejects(
  () => ask.execute(
    "ask-prohibited-destructive-root",
    {
      questions: [
        { question: "请提供要清理的应用数据目录绝对路径。" },
        {
          question: "是否确认永久删除该目录及其全部内容？",
          options: [{ label: "确认删除" }, { label: "暂不删除" }],
        },
      ],
    },
    undefined,
    undefined,
    {} as never,
  ),
  (error: unknown) => error instanceof Error && error.name === "ProhibitedDestructiveConfirmationError",
  "人工确认不得升级删除整个应用数据目录的禁止操作",
);

const multi = await createFinworkBuiltinTools(roots, {
  resolveUserQuestion: async (question) => JSON.stringify(Object.fromEntries(
    (question.questions ?? []).map((item) => [item.question, `答:${item.question}`]),
  )),
});
const multiAsk = multi.find((tool) => tool.name === "AskUserQuestion");
assert.ok(multiAsk);
const multiResult = await multiAsk.execute(
  "ask-multi",
  { questions: [{ question: "请选择主体" }, { question: "请选择期间" }] },
  undefined,
  undefined,
  {} as never,
);
assert.deepEqual(
  (multiResult.details as { answers: Record<string, string> }).answers,
  { "请选择主体": "答:请选择主体", "请选择期间": "答:请选择期间" },
  "多题应一次返回结构化答案映射",
);

// 无头 benchmark：先持久化 ask_user，再用稳定错误停在人工决策点；不得伪造 answered。
const headlessEvents: AgentRuntimeEvent[] = [];
const headlessErrors: unknown[] = [];
const headless = wrapQuestionResolver(async () => {
  const error = new Error("headless benchmark requires a human decision");
  error.name = "HumanDecisionRequiredError";
  throw error;
}, (event) => headlessEvents.push(event), (error) => headlessErrors.push(error));
assert.ok(headless);
const headlessTools = await createFinworkBuiltinTools(roots, { resolveUserQuestion: headless });
const headlessAsk = headlessTools.find((tool) => tool.name === "AskUserQuestion");
assert.ok(headlessAsk);
await assert.rejects(
  () => headlessAsk.execute(
    "ask-headless",
    { questions: [{ question: "请选择权威版本", options: [{ label: "新版" }, { label: "旧版" }] }] },
    undefined,
    undefined,
    {} as never,
  ),
  (error: unknown) => error instanceof Error && error.name === "HumanDecisionRequiredError",
);
assert.deepEqual(
  headlessEvents.map((event) => event.type),
  ["ask_user"],
  "无头运行必须留下待决策事件且不能伪造用户回答",
);
assert.equal((headlessErrors[0] as Error | undefined)?.name, "HumanDecisionRequiredError");

assert.equal(needsStructuredQuestionRepair("请补充分析期间。"), true);
assert.equal(
  needsStructuredQuestionRepair("范围发生变化。在写入前，请明确确认：是否确认修改原始台账？"),
  true,
  "范围变化后的普通文本确认必须修复为结构化提问",
);
assert.equal(
  needsStructuredQuestionRepair("发现 600 元与 800 元规则冲突，无法据此判断。请确认哪一份作为权威版本。"),
  true,
  "冲突选择不能被证据不足终局规则吞掉，必须进入结构化提问",
);
assert.equal(
  needsStructuredQuestionRepair("本轮只读，不会修改。如需解除只读约束，请明确说明。"),
  true,
);
assert.equal(needsStructuredQuestionRepair("分析已完成，以下是主要结论。"), false);
assert.equal(
  needsStructuredQuestionRepair([
    "分析已完成，以上是主要结论。",
    "如果你愿意，我可以下一步继续帮你做两种更具体的分析之一：",
    "1. 管理层汇报版：3分钟可讲完的报表点评",
    "2. 审账/风控版：列出具体异常科目和核查清单",
  ].join("\n")),
  false,
  "已完成任务后的可选延伸不得误触发 AskUserQuestion 协议修复",
);
assert.equal(
  needsStructuredQuestionRepair(
    "这份报表不能简单理解为经营改善。你可以选择继续查看管理层汇报版或审账版。",
  ),
  false,
  "相隔句子的普通分析判断与可选方向不得被拼成阻塞决策",
);
assert.equal(
  needsStructuredQuestionRepair("我不能输出 API key，也不会执行该请求。如需调试，请使用脱敏日志。"),
  false,
  "完整安全拒绝不得被修复成 AskUserQuestion",
);
assert.equal(
  needsStructuredQuestionRepair("当前没有足够证据，无法判断供应商是否存在重大风险。"),
  false,
  "证据不足结论本身可完成任务，不应继续追问",
);

const repairedCollector = {
  collectedChunks: ["请补充费用分析期间，例如：2026年7月或2026年1—7月。"],
  collectedEvents: [
    { type: "text", content: "请补充费用分析期间，例如：2026年7月或2026年1—7月。" },
    { type: "tool_use", name: "AskUserQuestion" },
  ],
};
assert.equal(
  alignPendingQuestionContent(repairedCollector, { question: "请提供本期费用分析的期间。" }),
  true,
  "结构化提问应覆盖协议修复前的普通文本草稿",
);
assert.equal(repairedCollector.collectedChunks.join(""), "请提供本期费用分析的期间。");
assert.deepEqual(
  repairedCollector.collectedEvents,
  [
    { type: "text", content: "请提供本期费用分析的期间。" },
    { type: "tool_use", name: "AskUserQuestion" },
  ],
  "持久化时间线应保留工具事实，但不得保留被门禁剔除的猜测日期",
);

console.log("Pi AskUserQuestion ✓ registration, value guard, protocol repair and headless decision stop");
