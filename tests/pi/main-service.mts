import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildPiPrompt,
  canContinueReadOnlyTurnAfterProviderFailure,
  lastAssistantError,
  resolveResumableSession,
  throwIfLastAssistantProviderError,
  validatePiSessionLocator,
} from "../../lib/agent/pi/agent-service.ts";

const root = mkdtempSync(path.join(tmpdir(), "finwork-pi-main-service-"));
const sessions = path.join(root, "sessions");
mkdirSync(sessions, { recursive: true });
const sessionFile = path.join(sessions, "session.jsonl");
writeFileSync(sessionFile, "{}\n", "utf8");

assert.equal(validatePiSessionLocator(sessionFile, sessions), realpathSync(sessionFile));
assert.throws(
  () => validatePiSessionLocator(path.join(root, "outside.jsonl"), sessions),
  /不存在|受控目录/,
);
const outside = path.join(root, "outside.jsonl");
writeFileSync(outside, "{}\n", "utf8");
assert.throws(() => validatePiSessionLocator(outside, sessions), /受控目录/);

// resolveResumableSession：分开「可用性」与「安全」两种失败。
// 会话文件不在了（保留期清掉 / app-data 迁移 / 历史遗留的假 locator）→ 起新会话，
// 不能把整轮对话打死；而越界路径仍必须硬失败。
assert.equal(
  resolveResumableSession(randomUUID(), sessions),
  null,
  "非路径 locator（历史自铸 UUID）应降级为新会话",
);
assert.equal(
  resolveResumableSession(path.join(sessions, "pruned.jsonl"), sessions),
  null,
  "受控目录内已被清理的 session 应降级为新会话",
);
assert.equal(
  resolveResumableSession(sessionFile, sessions),
  realpathSync(sessionFile),
  "受控目录内存在的 session 应正常恢复",
);
assert.throws(
  () => resolveResumableSession(outside, sessions),
  /受控目录/,
  "越界 session 必须硬失败，不得降级",
);

const fresh = buildPiPrompt(
  [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "当前请求" },
  ],
  [{
    name: "note.txt",
    mimeType: "text/plain",
    size: 4,
    dataUrl: "data:text/plain;base64,bm90ZQ==",
    text: "note",
  }],
);
// L3b：历史不再压进提示词文本，改由 extension 的 context 钩子作为真消息注入。
assert.doesNotMatch(fresh.text, /<对话回顾>/, "历史不应再出现在提示词里");
assert.doesNotMatch(fresh.text, /第一问|第一答/, "历史内容不应泄进当前提示词");
assert.match(fresh.text, /当前请求/);
assert.match(fresh.text, /<attachment name="note.txt">/);

const planned = buildPiPrompt(
  [{ role: "user", content: "分析报表" }],
  [],
  undefined,
  [],
  {
    planId: "plan-1",
    caseId: "case-1",
    version: 1,
    goal: "分析报表",
    status: "active",
    steps: [{
      stepId: "step-1",
      stepKey: "inspect_inputs",
      title: "检查输入",
      expectedOutcome: "读取报表",
      status: "ready",
      ordinal: 0,
      userVisible: true,
      blocking: true,
    }],
  },
);
assert.match(planned.text, /进度由结构化 WorkPlan 和工具事件展示/);
assert.match(planned.text, /不要在工具调用之间输出.*过程旁白/);

const resumed = buildPiPrompt(
  [
    { role: "user", content: "旧问题" },
    { role: "assistant", content: "旧回答" },
    { role: "user", content: "只发这一条" },
  ],
  [],
);
assert.equal(resumed.text, "只发这一条");
assert.equal(resumed.images.length, 0);

const image = buildPiPrompt(
  [{ role: "user", content: "看图" }],
  [{
    name: "red.png",
    mimeType: "image/png",
    size: 3,
    dataUrl: "data:image/png;base64,cmVk",
  }],
);
assert.equal(image.images.length, 1);
assert.equal(image.images[0].data, "cmVk");

const csvPath = path.join(root, "payroll.csv");
writeFileSync(csvPath, "name,gross\n张敏,20000\n", "utf8");
const localText = buildPiPrompt(
  [{ role: "user", content: "计算附件工资" }],
  [{
    name: "payroll.csv",
    mimeType: "text/csv",
    size: 25,
    dataUrl: "",
    storagePath: csvPath,
  }],
);
assert.match(localText.text, /张敏,20000/);
assert.match(localText.text, /无需调用工具读取/);
assert.doesNotMatch(localText.text, /请用 read_document/);

const xlsxPrompt = buildPiPrompt(
  [{ role: "user", content: "把个税公式写入 Excel" }],
  [{
    name: "tax.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 100,
    dataUrl: "",
    storagePath: path.join(root, "tax.xlsx"),
  }],
);
assert.match(xlsxPrompt.text, /先用 read 加载 xlsx Skill：.*agent-skills\/skills\/xlsx\/SKILL\.md/);
assert.match(xlsxPrompt.text, /受管 assetId 表格.*`patch_workspace_workbook`/);
assert.match(xlsxPrompt.text, /旧式路径附件.*`patch_workbook`/);
assert.match(xlsxPrompt.text, /优先用 `create_workbook` \/ `patch_workspace_workbook`/);
assert.match(xlsxPrompt.text, /通用工具不足.*反复 edit Python 脚本/);
assert.match(xlsxPrompt.text, /read_workspace_file 获取任务内只读 taskPath/);
assert.match(xlsxPrompt.text, /不能覆盖输入/);
assert.match(xlsxPrompt.text, /不得用 openpyxl\/pandas 对用户现有工作簿做 load→save/);
assert.match(xlsxPrompt.text, /begin_workspace_change.*planId/);
assert.match(xlsxPrompt.text, /review_workspace_change\(planId=.*final=true\)/);
assert.match(xlsxPrompt.text, /finalize_deliverable/);
const xlsxReadOnlyPrompt = buildPiPrompt(
  [{ role: "user", content: "分析下这个报表" }],
  [{
    name: "report.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 100,
    dataUrl: "",
    storagePath: path.join(root, "report.xlsx"),
  }],
  {
    version: 1,
    taskKind: "spreadsheet",
    spreadsheetRequirement: {
      needsLegacyXlsRead: false,
      needsWrite: false,
      needsRecalc: false,
      needsRender: false,
      needsMacroPreservation: false,
    },
    requiredDeliverables: [],
    expectationSnapshot: {},
  },
);
assert.match(xlsxReadOnlyPrompt.text, /表格只读分析任务/);
assert.match(xlsxReadOnlyPrompt.text, /受管 assetId 附件用 read_workspace_file/);
assert.match(xlsxReadOnlyPrompt.text, /旧式路径附件才用 read_document/);
assert.match(xlsxReadOnlyPrompt.text, /当前合同不要求创建、修改或交付文件/);
assert.match(xlsxReadOnlyPrompt.text, /交叉核对资产负债表、利润表和现金流量表/);
assert.match(xlsxReadOnlyPrompt.text, /必须再用 read 加载经营分析 Skill/);
assert.match(xlsxReadOnlyPrompt.text, /固定解析器 .*business-analysis\/scripts\/parse_statements\.py/);
assert.match(xlsxReadOnlyPrompt.text, /run_task_python 在任务沙箱执行/);
assert.match(xlsxReadOnlyPrompt.text, /不得把它改称独立研发费用/);
assert.doesNotMatch(xlsxReadOnlyPrompt.text, /完成后必须检查输出文件/);
const xlsxRecalcPrompt = buildPiPrompt(
  [{ role: "user", content: "生成需要重算的 Excel" }],
  [{
    name: "tax.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 100,
    dataUrl: "",
    storagePath: path.join(root, "tax.xlsx"),
  }],
  {
    version: 1,
    taskKind: "spreadsheet",
    spreadsheetRequirement: {
      needsLegacyXlsRead: false,
      needsWrite: true,
      needsRecalc: true,
      needsRender: true,
      needsMacroPreservation: false,
    },
    requiredDeliverables: [],
    expectationSnapshot: {},
  },
);
assert.match(xlsxRecalcPrompt.text, /由 `finalize_deliverable` 在沙箱外的受控运行时完成/);
assert.match(xlsxRecalcPrompt.text, /不要在 Bash 中启动 soffice/);

const docxPrompt = buildPiPrompt(
  [{ role: "user", content: "生成董事会批准备忘录" }],
  [],
  {
    version: 1,
    taskKind: "text",
    requiredDeliverables: [{
      id: "memo",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      count: 1,
      qualityProfile: "generic",
    }],
    expectationSnapshot: {},
  },
);
assert.match(docxPrompt.text, /用 `run_task_python` 执行/);
assert.match(docxPrompt.text, /不要改用 Bash、自行启动 Python/);
assert.match(docxPrompt.text, /默认无网络、不能启动子进程/);
assert.match(docxPrompt.text, /由 finalize_deliverable 在受控运行时完成/);

const transientErrorThenSuccess = [
  {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [] },
  },
  {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  },
] as never;
assert.equal(
  lastAssistantError(transientErrorThenSuccess),
  undefined,
  "repair 后成功的最终 assistant 结束态应覆盖更早的 transient error",
);
assert.doesNotThrow(
  () => throwIfLastAssistantProviderError(transientErrorThenSuccess, "gpt-test", false),
  "后续成功结束态应允许正常进入交付门禁",
);
const terminalProviderError = [{ type: "turn_start" }, {
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage: "503 auth_unavailable: no auth available (providers=codex, model=gpt-test)",
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  },
}] as never;
assert.throws(
  () => throwIfLastAssistantProviderError(terminalProviderError, "gpt-test", false),
  (error: unknown) => {
    assert.equal((error as { code?: string }).code, "PROVIDER_RESPONSE_ERROR");
    assert.equal((error as { __numTurns?: number }).__numTurns, 1);
    assert.match((error as Error).message, /auth_unavailable/);
    return true;
  },
  "Provider 错误必须在 completion repair 前立即抛出",
);

const transientProviderError = Object.assign(new Error("stream disconnected before response.completed"), {
  code: "PROVIDER_RESPONSE_ERROR",
});
const readOnlyContract = {
  version: 1,
  taskKind: "spreadsheet",
  spreadsheetRequirement: {
    needsLegacyXlsRead: false,
    needsWrite: false,
    needsRecalc: false,
    needsRender: false,
    needsMacroPreservation: false,
  },
  requiredDeliverables: [],
  expectationSnapshot: {},
} as const;
assert.equal(
  canContinueReadOnlyTurnAfterProviderFailure(transientProviderError, [{
    toolCallId: "read-1",
    toolName: "read_workspace_file",
    capabilityIds: ["spreadsheet.read"],
    completedAt: new Date().toISOString(),
  }], readOnlyContract),
  true,
  "只读任务在临时断流后应允许同 session 续答一次",
);
assert.equal(
  canContinueReadOnlyTurnAfterProviderFailure(transientProviderError, [{
    toolCallId: "write-1",
    toolName: "patch_workbook",
    capabilityIds: ["spreadsheet.write"],
    completedAt: new Date().toISOString(),
  }], readOnlyContract),
  false,
  "出现写入副作用后不得自动续答",
);

console.log("Pi main service ✓ controlled locator, fresh/resume prompt and attachments");
