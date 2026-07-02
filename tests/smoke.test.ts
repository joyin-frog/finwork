import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { calculateCumulativePayroll } from "../lib/domain/tax-cumulative";
import { validateReimbursements } from "../lib/domain/reimbursement";
import { summarizeExpenses } from "../lib/domain/analysis";
import {
  countChatConversations,
  createChatConversation,
  getConversationAttachments,
  getMessageAttachments,
  insertAuditLog,
  insertChatAttachment,
  insertChatMessage,
  initializeFinanceDatabase,
  listRecentChatConversations,
  openFinanceDatabase,
  setChatConversationClaudeSessionId
} from "../lib/db/sqlite";
import { runClaudeAgent } from "../lib/agent/claude-adapter";
import { toPublicClaudeSettings } from "../lib/settings/claude-settings";
import { POST as postAgentQuery } from "../app/api/agent/query/route";
import { getAppDataDir, getConversationFilesDir, getDatabasePath, getPythonPath, getSettingsPath } from "../lib/runtime/paths";
import * as zod from "zod/v4";

async function main() {
  process.env.FINANCE_AGENT_APP_DATA_DIR = `/tmp/finance-agent-smoke-app-data-${process.pid}`;
  process.env.FINANCE_AGENT_SETTINGS_PATH = `/tmp/finance-agent-smoke-settings-${process.pid}.json`;
  process.env.FINANCE_AGENT_DB_PATH = `/tmp/finance-agent-smoke-${process.pid}.db`;

  assert.equal(getAppDataDir(), process.env.FINANCE_AGENT_APP_DATA_DIR);
  assert.equal(getDatabasePath(), process.env.FINANCE_AGENT_DB_PATH);
  assert.equal(getSettingsPath(), process.env.FINANCE_AGENT_SETTINGS_PATH);

  const payroll = calculateCumulativePayroll({
    employeeName: "测试员工",
    grossPay: 20000,
    socialInsurance: 2000,
    housingFund: 1500,
    specialDeduction: 1000,
    monthsEmployed: 1
  });

  // 首月累计口径:20000 − 5000 − 3500 − 1000 = 10500 → 3% 档
  assert.equal(payroll.detail.taxableIncomeCum, 10500);
  assert.equal(payroll.taxCurrent, 315);
  assert.equal(payroll.netPay, 16185);

  const reimbursements = validateReimbursements(
    [
      { employeeName: "A", expenseDate: "2026-05-01", invoiceNo: "INV-1", category: "交通", amount: 100 },
      { employeeName: "B", expenseDate: "2026-05-02", invoiceNo: "INV-1", category: "", amount: 2000 }
    ],
    { singleLimit: 1500 }
  );

  assert.deepEqual(reimbursements[0].warnings, ["发票号重复"]);
  assert.deepEqual(reimbursements[1].warnings, ["缺少类目", "超过单笔标准", "发票号重复"]);

  const pythonPath = getPythonPath();
  const workerOutput = execFileSync(pythonPath, ["workers/finance_worker.py", "demo"], {
    encoding: "utf-8"
  });
  const workerJson = JSON.parse(workerOutput);
  assert.equal(workerJson.row_count, 3);
  assert.equal(workerJson.warnings.length, 1);

  // Path function tests
  const filesDir = getConversationFilesDir(42);
  assert.ok(filesDir.endsWith(path.join("files", "42")), `files dir should end with files/42, got: ${filesDir}`);
  assert.ok(pythonPath.includes(".venv"), `python path should use venv, got: ${pythonPath}`);

  // Python extract-text test
  const xlsxTestDir = path.join(process.env.FINANCE_AGENT_APP_DATA_DIR!, "test-files");
  mkdirSync(xlsxTestDir, { recursive: true });
  const xlsxPath = path.join(xlsxTestDir, "test_extract.xlsx");
  // Create a minimal xlsx via Python
  execFileSync(pythonPath, ["-c", `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Test"
ws.append(["Name", "Amount"])
ws.append(["Item1", "100"])
ws.append(["Item2", "200"])
ws["C1"] = "Double"
ws["C2"] = "=B2*2"
ws.freeze_panes = "A2"
ws.auto_filter.ref = "A1:C3"
wb.save("${xlsxPath}")
`]);
  const extractedText = execFileSync(pythonPath, ["workers/finance_worker.py", "extract-text", xlsxPath], {
    encoding: "utf-8"
  });
  assert.ok(extractedText.includes("Name"), `extracted text should contain 'Name', got: ${extractedText.slice(0, 100)}`);
  assert.ok(extractedText.includes("Item1"), `extracted text should contain 'Item1'`);
  assert.ok(extractedText.includes("100"), `extracted text should contain '100'`);

  const inspectedText = execFileSync(pythonPath, ["workers/finance_worker.py", "inspect-excel", xlsxPath], {
    encoding: "utf-8"
  });
  const inspected = JSON.parse(inspectedText) as {
    sheets: Array<{ name: string; headers: string[]; formula_count: number; frozen_panes?: string; auto_filter?: string }>;
  };
  assert.equal(inspected.sheets[0].name, "Test");
  assert.ok(inspected.sheets[0].headers.includes("Double"));
  assert.equal(inspected.sheets[0].formula_count, 1);
  assert.equal(inspected.sheets[0].frozen_panes, "A2");

  // Python run (code interpreter) test
  const runOutputDir = path.join(process.env.FINANCE_AGENT_APP_DATA_DIR!, "test-run-output");
  mkdirSync(runOutputDir, { recursive: true });
  const runResult = execFileSync(pythonPath, ["workers/finance_worker.py", "run"], {
    encoding: "utf-8",
    env: { ...process.env, FINANCE_AGENT_OUTPUT_DIR: runOutputDir },
    input: `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "RunTest"
ws.append(["Col1", "Col2"])
ws.append(["A", "B"])
wb.save(Path(output_dir) / "generated.xlsx")
`
  });
  const runJson = JSON.parse(runResult);
  assert.equal(runJson.files.length, 1, `expected 1 generated file, got ${runJson.files.length}`);
  assert.equal(runJson.files[0].name, "generated.xlsx");
  assert.ok(runJson.files[0].size_bytes > 0);

  const analysis = summarizeExpenses([
    { category: "交通", amount: 100 },
    { category: "交通", amount: 50 },
    { category: "办公", amount: 200 }
  ]);

  assert.equal(analysis.total, 350);
  assert.equal(analysis.topCategory, "办公");
  assert.deepEqual(analysis.byCategory[1], { category: "交通", amount: 150 });

  const db = initializeFinanceDatabase(openFinanceDatabase(":memory:"));
  const auditId = insertAuditLog("smoke_test", { ok: true });
  assert.equal(auditId, 1);

  const longTitle = "请完整保留这条很长的财务对话标签，不要因为展示省略而截断数据库里的原始问题";
  const conversationId = createChatConversation(longTitle);
  setChatConversationClaudeSessionId(conversationId, "11111111-1111-4111-8111-111111111111");
  insertChatMessage(conversationId, "user", longTitle);
  insertChatMessage(conversationId, "assistant", "已保存完整回答");
  const recentConversations = listRecentChatConversations(10);
  assert.equal(countChatConversations(), 1);
  assert.equal(recentConversations[0].title, longTitle);
  assert.equal(recentConversations[0].claudeSessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(
    recentConversations[0].messages.map((message) => message.role),
    ["user", "assistant"]
  );

  // Attachment CRUD
  const attachmentId = randomUUID();
  const attachmentMessageId = insertChatMessage(conversationId, "user", "带附件的消息");
  insertChatAttachment({
    id: attachmentId,
    messageId: attachmentMessageId,
    fileName: "test.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 2048,
    storagePath: "upload/test.xlsx",
    role: "user"
  });

  const messageAtts = getMessageAttachments(attachmentMessageId);
  assert.equal(messageAtts.length, 1);
  assert.equal(messageAtts[0].fileName, "test.xlsx");
  assert.equal(messageAtts[0].storagePath, "upload/test.xlsx");
  assert.equal(messageAtts[0].role, "user");

  const convAtts = getConversationAttachments(conversationId);
  assert.ok(convAtts.length >= 1);
  assert.ok(convAtts.some((a) => a.id === attachmentId));

  db.close();

  const publicSettings = toPublicClaudeSettings({
    apiUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test-1234567890",
    model: "claude-sonnet-4-5",
    companyName: "",
    agentName: "小财",
    routerModel: "",
    subagentModel: "",
    mainModel: "",
    roleMode: "tech",
  });
  assert.equal(publicSettings.apiKeyConfigured, true);
  assert.equal(publicSettings.apiKeyPreview, "sk-a...7890");
  assert.equal(publicSettings.model, "claude-sonnet-4-5");

  const agentResult = await runClaudeAgent([{ role: "user", content: "测试未配置时回退" }]);
  assert.equal(agentResult.mode, "mock");

  const routeResponse = await postAgentQuery(
    new Request("http://finance-agent.local/api/agent/query?stream=false", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "这是一条需要完整保存成标签的对话记录" }]
      })
    })
  );
  const routeJson = (await routeResponse.json()) as {
    data: {
      conversationId: number;
      claudeSessionId: string;
      conversation: { title: string; claudeSessionId: string; messages: Array<{ role: string; content: string }> };
    };
  };
  assert.ok(routeJson.data.conversationId > 0);
  assert.match(routeJson.data.claudeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(routeJson.data.conversation.claudeSessionId, routeJson.data.claudeSessionId);
  assert.equal(routeJson.data.conversation.title, "这是一条需要完整保存成标签的对话记录");
  assert.deepEqual(
    routeJson.data.conversation.messages.map((message) => message.role),
    ["user", "assistant"]
  );

  const streamingResponse = await postAgentQuery(
    new Request("http://finance-agent.local/api/agent/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "测试流式事件返回" }]
      })
    })
  );
  assert.equal(streamingResponse.headers.get("content-type"), "text/event-stream");
  const streamText = await streamingResponse.text();
  assert.ok(streamText.includes('"type":"done"'), `stream should include done event, got ${streamText}`);
  assert.ok(streamText.includes('"conversationId"'), `stream should include conversation id, got ${streamText}`);

  // Multipart upload test — send real FormData without manual boundary
  const xlsxBuffer = Buffer.from("test content");
  const multipartForm = new FormData();
  multipartForm.append("messages", JSON.stringify([{ role: "user", content: "分析附件表格" }]));
  multipartForm.append("files", new Blob([xlsxBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "test_upload.xlsx");

  const multipartRequest = new Request("http://finance-agent.local/api/agent/query?stream=false", {
    method: "POST",
    body: multipartForm
  });
  const multipartResponse = await postAgentQuery(multipartRequest);
  assert.equal(multipartResponse.status, 200);
  const multipartJson = (await multipartResponse.json()) as {
    data: { conversationId: number; conversation: { title: string } };
  };
  assert.ok(multipartJson.data.conversationId > 0);

  await testKingdeeMcpIntegration();

  console.log("smoke tests passed");
}

async function testKingdeeMcpIntegration() {
  console.log("  Testing: Kingdee MCP tools...");

  const { createKingdeeTools } = await import("../lib/agent/mcp-tools/kingdee-tools");

  const tools: Record<string, { name: string; schema: unknown; handler: (args: unknown) => unknown }> = {};
  const mockSdk = {
    tool(name: string, _desc: string, schema: unknown, handler: (args: unknown) => unknown) {
      tools[name] = { name, schema, handler };
      return { name };
    }
  };

  const kingdeeTools = createKingdeeTools(mockSdk as any);
  // 4 原有 + 6 单据→凭证(check/map/summarize/build_lines/build_sheet/process_batch)
  assert.equal(kingdeeTools.length, 10);

  // 1. Test query_kingdee_accounts
  const queryHandler = tools["query_kingdee_accounts"]?.handler;
  if (!queryHandler) throw new Error("query_kingdee_accounts not registered");
  const queryResult = await queryHandler({ accountCode: "6602" });
  const parsed = JSON.parse((queryResult as any).content[0].text);
  assert.ok(parsed.totalCount >= 1, "Should return matching accounts");
  assert.ok(parsed.accounts.some((a: any) => a.code === "6602.01"), "Should include 6602.01");

  // 2. Test export_kingdee_draft
  const exportHandler = tools["export_kingdee_draft"]?.handler;
  if (!exportHandler) throw new Error("export_kingdee_draft not registered");
  const exportResult = await exportHandler({
    company: "深圳腾讯",
    period: "2026-06",
    entries: [{
      date: "2026-06-05",
      summary: "差旅报销-测试",
      debitAccount: "6602.01",
      debitAmount: 3500,
      creditAccount: "1001",
      creditAmount: 3500,
      attachmentCount: 2
    }]
  });
  const draft = JSON.parse((exportResult as any).content[0].text);
  assert.equal(draft.voucherDraft.status, "draft", "Status should be draft");
  assert.equal(draft.voucherDraft.balanced, true, "Should be balanced");
  assert.equal(draft.simulated, true, "Should be marked as simulated");

  // 3. Test validate_kingdee_voucher (valid)
  const validateHandler = tools["validate_kingdee_voucher"]?.handler;
  if (!validateHandler) throw new Error("validate_kingdee_voucher not registered");
  const validResult = await validateHandler({ voucherJson: JSON.stringify(draft) });
  const validation = JSON.parse((validResult as any).content[0].text);
  assert.equal(validation.valid, true, "Should validate as true: " + JSON.stringify(validation.errors));

  // 4. Test validate_kingdee_voucher (unbalanced)
  const unbalanced = {
    voucherDraft: {
      id: "test-unbalanced",
      entries: [{ debitAccount: "6602.01", debitAmount: 5000, creditAccount: "1001", creditAmount: 3000 }],
      totalDebit: 5000,
      totalCredit: 3000,
      balanced: false
    }
  };
  const unbalResult = await validateHandler({ voucherJson: JSON.stringify(unbalanced) });
  const unbalValidation = JSON.parse((unbalResult as any).content[0].text);
  assert.equal(unbalValidation.valid, false, "Should reject unbalanced voucher");
  assert.ok(unbalValidation.errors.length > 0, "Should have error messages");

  // 5. Test unknown account code
  const badCode = {
    voucherDraft: {
      id: "test-badcode",
      entries: [{ debitAccount: "9999.99", debitAmount: 100, creditAccount: "1001", creditAmount: 100 }],
      totalDebit: 100,
      totalCredit: 100,
      balanced: true
    }
  };
  const badResult = await validateHandler({ voucherJson: JSON.stringify(badCode) });
  const badValidation = JSON.parse((badResult as any).content[0].text);
  assert.equal(badValidation.valid, false, "Should reject unknown account code");
  assert.ok(badValidation.errors.some((e: string) => e.includes("9999.99")), "Error should mention the bad code");

  console.log("  ✓ Kingdee MCP integration tests passed\n");
}

export const smokeTestPromise = main();

smokeTestPromise.catch((error) => {
  console.error(error);
  process.exit(1);
});
