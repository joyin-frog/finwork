import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFinworkBuiltinTools } from "../../lib/agent/pi/builtin-tools.ts";
import { wrapQuestionResolver } from "../../lib/agent/pi/agent-service.ts";
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
const headless = wrapQuestionResolver(async () => {
  const error = new Error("headless benchmark requires a human decision");
  error.name = "HumanDecisionRequiredError";
  throw error;
}, (event) => headlessEvents.push(event));
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

console.log("Pi AskUserQuestion ✓ registration, live answer events and headless decision stop");
