import assert from "node:assert/strict";
import { resolveAgentContextPolicy } from "../lib/agent/context-policy.ts";

const message = (content: string) => [{ role: "user" as const, content }];
const managedAssetId = "11111111-1111-4111-8111-111111111111";

const unknown = resolveAgentContextPolicy({ messages: message("帮我处理一下这个财务事项") });
assert.deepEqual(unknown.toolIds, [], "未知任务必须使用最小工具包，禁止回退到完整目录");
assert.deepEqual(unknown.skillNames, []);
assert.deepEqual(unknown.builtinToolIds, ["read", "grep", "find", "ls", "AskUserQuestion"]);

const payroll = resolveAgentContextPolicy({
  messages: message("请根据工资表计算本月个税"),
  attachments: [{ name: "工资表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "tool_task",
  artifactWrite: true,
});
assert.deepEqual(new Set(payroll.skillNames), new Set(["payroll-calc", "xlsx"]));
assert.ok(payroll.toolIds?.includes("calculate_payroll_batch"));
assert.ok(payroll.toolIds?.includes("create_workbook"), "新建 XLSX 任务必须保留 create_workbook");
assert.ok(payroll.toolIds?.includes("patch_workspace_workbook"));
assert.ok(!payroll.toolIds?.includes("begin_workspace_change"), "内部计划工具不得暴露给模型");
assert.ok(!payroll.toolIds?.includes("review_workspace_change"), "内部复核工具不得暴露给模型");
assert.ok(!payroll.toolIds?.includes("patch_workbook"), "受管附件不得同时暴露旧路径 patch 工具");
assert.ok(!payroll.toolIds?.includes("check_workbook_ties"), "确定性校验应由 Harness 执行");
assert.ok(!payroll.toolIds?.includes("export_kingdee_draft"));

const rag = resolveAgentContextPolicy({
  messages: message("公司差旅住宿标准是什么"),
  intent: "rag_qa",
});
assert.deepEqual(rag.skillNames, []);
assert.deepEqual(
  new Set(rag.toolIds),
  new Set([
    "search_knowledge",
  ]),
);

const mixed = resolveAgentContextPolicy({
  messages: message("把银行流水对账后整理成金蝶凭证"),
  attachments: [{ name: "流水.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "complex_workflow",
  artifactWrite: true,
});
assert.ok(mixed.profiles.includes("bank") && mixed.profiles.includes("voucher"));
assert.ok(mixed.toolIds?.includes("reconcile_bank_statement"));
assert.ok(mixed.toolIds?.includes("process_voucher_batch"));
assert.ok(!mixed.toolIds?.includes("check_voucher_amount"));
assert.ok(!mixed.toolIds?.includes("map_voucher_account"));
assert.ok(!mixed.toolIds?.includes("build_voucher_lines"));

const multiDeliverable = resolveAgentContextPolicy({
  messages: message("生成预算差异 Excel 和 Word 简报两个正式交付物"),
  attachments: [{ name: "预算.csv", mimeType: "text/csv", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "complex_workflow",
  artifactWrite: true,
});
assert.ok(multiDeliverable.skillNames?.includes("xlsx"));
assert.ok(multiDeliverable.skillNames?.includes("docx"));
assert.ok(multiDeliverable.toolIds?.includes("create_workbook"));

const delegatedDepartments = resolveAgentContextPolicy({
  messages: message("请并行派专员分别分析三个部门的预算执行，再汇总共性风险"),
  attachments: [{ name: "预算.csv", mimeType: "text/csv", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "complex_workflow",
  artifactWrite: true,
});
assert.ok(delegatedDepartments.profiles.includes("batch"));
assert.ok(delegatedDepartments.profiles.includes("business"));
assert.ok(delegatedDepartments.toolIds?.includes("spawn_subagent"));
assert.ok(delegatedDepartments.skillNames?.includes("finance-analysis"));

const confirmationFirst = resolveAgentContextPolicy({
  messages: message("根据附件生成金蝶凭证草稿文件；先发起导出确认，不要用其他方式绕过"),
  attachments: [{ name: "单据.csv", mimeType: "text/csv", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "tool_task",
});
assert.deepEqual(confirmationFirst.toolIds, ["export_kingdee_draft"]);
assert.ok(confirmationFirst.skillNames?.includes("kingdee-draft"));

const voucherBatch = resolveAgentContextPolicy({
  messages: message("根据附件批量生成凭证草稿预览：先勾稽金额、映射科目、检查借贷平衡"),
  attachments: [{ name: "单据.csv", mimeType: "text/csv", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "tool_task",
});
assert.deepEqual(voucherBatch.toolIds, ["process_voucher_batch"]);

const sessionOnly = resolveAgentContextPolicy({
  messages: message("记住本次会话的口径"),
  intent: "tool_task",
});
assert.deepEqual(sessionOnly.toolIds, [], "一次性会话口径不能触发长期记忆工具");

const longTerm = resolveAgentContextPolicy({
  messages: message("以后所有报表都要带环比，请长期记住"),
  intent: "tool_task",
});
assert.ok(longTerm.toolIds?.includes("remember_convention"));

const readOnlyWorkbook = resolveAgentContextPolicy({
  messages: message("分析这份报表"),
  attachments: [{ name: "报表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1, dataUrl: "", assetId: managedAssetId }],
  intent: "tool_task",
  artifactWrite: false,
});
assert.ok(readOnlyWorkbook.toolIds?.includes("list_workspace_files"));
assert.ok(readOnlyWorkbook.toolIds?.includes("read_workspace_file"));
assert.ok(readOnlyWorkbook.toolIds?.includes("run_task_python"));
assert.ok(readOnlyWorkbook.toolIds?.includes("generate_business_analysis"));
assert.ok(!readOnlyWorkbook.toolIds?.includes("create_workbook"));
assert.ok(!readOnlyWorkbook.toolIds?.includes("patch_workspace_workbook"));
assert.ok(!readOnlyWorkbook.toolIds?.includes("finalize_deliverable"));

console.log("AS2 context policy: minimal fallback, domain union, managed artifact narrowing ✓");
