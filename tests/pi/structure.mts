import assert from "node:assert/strict";
import { buildFinanceToolDefinitions } from "../../lib/agent/mcp-tools/index.ts";
import { createPiFinanceTools } from "../../lib/agent/pi/tool-adapter.ts";
import { createFinanceToolAuthorizer } from "../../lib/agent/tools/authorize.ts";
import { PiEventMapper } from "../../lib/agent/pi/event-mapper.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentRunOptions, SubagentTask } from "../../lib/agent/subagent-contracts.ts";
import { formatFinworkSkillListing } from "../../lib/agent/pi/skill-tool.ts";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const definitions = buildFinanceToolDefinitions("/tmp/finwork-pi-structure");
assert.equal(definitions.length, 45, "AS0 production catalog count must stay frozen");
assert.equal(new Set(definitions.map((item) => item.id)).size, 45, "tool ids must be unique");

for (const id of [
  "read_document",
  "remember_convention",
  "analyze_tabular",
  "process_voucher_batch",
  "spawn_subagent",
]) {
  assert.ok(definitions.some((item) => item.id === id), `missing representative tool: ${id}`);
}

const allow = createFinanceToolAuthorizer({
  outputDir: "/tmp/finwork-pi-structure",
  conversationId: 91001,
  resolveUserQuestion: async () => "确认",
});
const tools = createPiFinanceTools(definitions, allow);
assert.equal(tools.length, definitions.length);
assert.deepEqual(
  tools.map((tool) => tool.name),
  definitions.map((definition) => definition.id),
  "Pi adapter must preserve canonical ids and order",
);
assert.ok(tools.every((tool) => tool.parameters.type === "object"), "model schemas must be objects");

const skillDir = mkdtempSync(path.join(tmpdir(), "finwork-pi-skill-"));
const skillPath = path.join(skillDir, "SKILL.md");
writeFileSync(skillPath, "---\nname: payroll-calc\ndescription: 工资确定性计算\n---\n# 薪税流程\n必须调用确定性引擎。\n");
const skillLoader = {
  getSkills: () => ({
    skills: [{
      name: "payroll-calc",
      description: "工资确定性计算",
      filePath: skillPath,
      baseDir: skillDir,
      sourceInfo: {} as never,
      disableModelInvocation: false,
    }],
    diagnostics: [],
  }),
} as ResourceLoader;
// L4：清单改为 pi 原生形态——给出 SKILL.md 绝对路径，模型用 read 读正文，
// 不再有自建 `Skill` 工具（它曾把 baseDir 告诉模型，却没有工具能读那些引用文件）。
const listing = formatFinworkSkillListing(skillLoader);
assert.match(listing, /<name>payroll-calc<\/name>/);
assert.match(listing, new RegExp(`<path>${skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</path>`),
  "清单必须带 SKILL.md 路径，否则模型无从 read");
assert.match(listing, /用 `read` 读/, "清单必须指明用 read 加载");

const remember = definitions.find((item) => item.name === "remember_convention")!;
const noResolver = createFinanceToolAuthorizer({
  outputDir: "/tmp/finwork-pi-structure",
  conversationId: 91002,
});
await assert.rejects(
  () => noResolver(remember, { text: "报表都要带环比" }, undefined),
  /需要用户确认/,
);

const reject = createFinanceToolAuthorizer({
  outputDir: "/tmp/finwork-pi-structure",
  conversationId: 91003,
  resolveUserQuestion: async () => "取消",
});
await assert.rejects(
  () => reject(remember, { text: "报表都要带环比" }, undefined),
  /用户取消/,
);

const processVoucher = tools.find((tool) => tool.name === "process_voucher_batch")!;
await assert.rejects(
  () => processVoucher.execute("invalid-zod", {}, undefined, undefined, {} as never),
  /invalid_type|Invalid input|expected/i,
);

const roleAuthorizer = createFinanceToolAuthorizer({
  outputDir: "/tmp/finwork-pi-structure",
  roleId: "treasury-officer",
});
await assert.rejects(
  () => roleAuthorizer(remember, { text: "越权" }, undefined),
  /超出.*职责|权限范围/,
);

const mapper = new PiEventMapper();
assert.deepEqual(
  mapper.map({ type: "agent_start" }).events,
  [{ type: "run_started" }],
);
assert.deepEqual(
  mapper.map({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read_document",
    args: { path: "fixture.txt" },
  }).events,
  [{
    type: "tool_started",
    toolName: "read_document",
    toolCallId: "tool-1",
    input: { path: "fixture.txt" },
  }],
);
const dropped = mapper.map({
  type: "entry_appended",
  entry: {} as never,
} as AgentSessionEvent);
assert.equal(dropped.trace.action, "dropped");
assert.deepEqual(dropped.events, []);

let injectedTask: SubagentTask | undefined;
let injectedOptions: SubagentRunOptions | undefined;
const injectedController = new AbortController();
const injectedDefinitions = buildFinanceToolDefinitions(
  "/tmp/finwork-pi-structure",
  undefined,
  undefined,
  undefined,
  {
    subagentExecutor: async (task, options) => {
      injectedTask = task;
      injectedOptions = options;
      return { label: task.label, content: "PI_SUBAGENT_INJECTED", success: true, durationMs: 1 };
    },
  },
);
const injectedTools = createPiFinanceTools(injectedDefinitions, allow);
const spawnSubagent = injectedTools.find((tool) => tool.name === "spawn_subagent")!;
const injectedResult = await spawnSubagent.execute(
  "pi-subagent-injection",
  {
    role: "analyst",
    instructions: "只验证执行器注入",
    label: "pi-injected",
  },
  injectedController.signal,
  undefined,
  {} as never,
);
assert.equal(injectedTask?.roleId, "analyst");
assert.equal(injectedOptions?.signal, injectedController.signal);
assert.match(
  injectedResult.content.find((item) => item.type === "text")?.text ?? "",
  /PI_SUBAGENT_INJECTED/,
);

console.log("Pi structure ✓ 45 definitions, schema/Zod, safety gates, event mapper and subagent seam");
