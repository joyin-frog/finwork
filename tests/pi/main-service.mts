import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildPiPrompt,
  lastAssistantError,
  resolveResumableSession,
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
assert.match(xlsxPrompt.text, /改动用户上传的表格.*必须用 `patch_workbook`/);
assert.match(xlsxPrompt.text, /新建空白表格必须调用 `create_workbook`/);
assert.match(xlsxPrompt.text, /不要用 Bash、Python、openpyxl 或 pandas 直接生成或改写 XLSX/);
assert.match(xlsxPrompt.text, /附件在沙箱中只读/);
assert.match(xlsxPrompt.text, /不得覆盖原件/);
assert.match(xlsxPrompt.text, /拆成多次受控工具调用/);
assert.match(xlsxPrompt.text, /不要用超长脚本绕过工具合同/);
assert.match(xlsxPrompt.text, /finalize_deliverable/);
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

console.log("Pi main service ✓ controlled locator, fresh/resume prompt and attachments");
