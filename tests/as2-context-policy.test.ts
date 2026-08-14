import assert from "node:assert/strict";
import { resolveAgentContextPolicy } from "../lib/agent/context-policy.ts";

const message = (content: string) => [{ role: "user" as const, content }];

const unknown = resolveAgentContextPolicy({ messages: message("帮我处理一下这个财务事项") });
assert.equal(unknown.toolIds, undefined, "未知任务必须保留全工具目录，不能猜测收窄");
assert.equal(unknown.skillNames, undefined, "未知任务必须保留全部 Skill listing");

const payroll = resolveAgentContextPolicy({
  messages: message("请根据工资表计算本月个税"),
  attachments: [{ name: "工资表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1, dataUrl: "" }],
  intent: "tool_task",
});
assert.deepEqual(new Set(payroll.skillNames), new Set(["payroll-calc", "xlsx"]));
assert.ok(payroll.toolIds?.includes("calculate_payroll_batch"));
assert.ok(payroll.toolIds?.includes("create_workbook"), "新建 XLSX 任务必须保留 create_workbook");
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
    "query_knowledge",
    "read_file",
    "read_document",
  ]),
);

const mixed = resolveAgentContextPolicy({
  messages: message("把银行流水对账后整理成金蝶凭证"),
  attachments: [{ name: "流水.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1, dataUrl: "" }],
  intent: "complex_workflow",
});
assert.ok(mixed.profiles.includes("bank") && mixed.profiles.includes("voucher"));
assert.ok(mixed.toolIds?.includes("reconcile_bank_statement"));
assert.ok(mixed.toolIds?.includes("process_voucher_batch"));

const multiDeliverable = resolveAgentContextPolicy({
  messages: message("生成预算差异 Excel 和 Word 简报两个正式交付物"),
  attachments: [{ name: "预算.csv", mimeType: "text/csv", size: 1, dataUrl: "" }],
  intent: "complex_workflow",
});
assert.ok(multiDeliverable.skillNames?.includes("xlsx"));
assert.ok(multiDeliverable.skillNames?.includes("docx"));
assert.ok(multiDeliverable.toolIds?.includes("create_workbook"));

const delegatedDepartments = resolveAgentContextPolicy({
  messages: message("请并行派专员分别分析三个部门的预算执行，再汇总共性风险"),
  attachments: [{ name: "预算.csv", mimeType: "text/csv", size: 1, dataUrl: "" }],
  intent: "complex_workflow",
});
assert.ok(delegatedDepartments.profiles.includes("batch"));
assert.ok(delegatedDepartments.profiles.includes("business"));
assert.ok(delegatedDepartments.toolIds?.includes("spawn_subagent"));
assert.ok(delegatedDepartments.skillNames?.includes("finance-analysis"));

const confirmationFirst = resolveAgentContextPolicy({
  messages: message("根据附件生成金蝶凭证草稿文件；先发起导出确认，不要用其他方式绕过"),
  attachments: [{ name: "单据.csv", mimeType: "text/csv", size: 1, dataUrl: "" }],
  intent: "tool_task",
});
assert.deepEqual(confirmationFirst.toolIds, ["export_kingdee_draft"]);
assert.ok(confirmationFirst.skillNames?.includes("kingdee-draft"));

const voucherBatch = resolveAgentContextPolicy({
  messages: message("根据附件批量生成凭证草稿预览：先勾稽金额、映射科目、检查借贷平衡"),
  attachments: [{ name: "单据.csv", mimeType: "text/csv", size: 1, dataUrl: "" }],
  intent: "tool_task",
});
assert.deepEqual(voucherBatch.toolIds, ["process_voucher_batch"]);

const sessionOnly = resolveAgentContextPolicy({
  messages: message("记住本次会话的口径"),
  intent: "tool_task",
});
assert.equal(sessionOnly.toolIds, undefined, "一次性会话口径不能触发长期记忆工具收窄");

const longTerm = resolveAgentContextPolicy({
  messages: message("以后所有报表都要带环比，请长期记住"),
  intent: "tool_task",
});
assert.ok(longTerm.toolIds?.includes("remember_convention"));

console.log("AS2 context policy: fallback, domain union, Skill and tool narrowing ✓");
