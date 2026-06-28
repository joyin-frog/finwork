import assert from "node:assert/strict";
import * as React from "react";
import { parseReimbursementStructured } from "../app/components/reimbursement-card-data.ts";

// tsx 直跑 .tsx 用 classic JSX 转换,需要 React 在全局作用域(Next 构建时为 automatic runtime,不受影响)
(globalThis as Record<string, unknown>).React = React;
import {
  parseVoucherDraftStructured,
  parseVoucherValidationStructured
} from "../app/components/kingdee-card-data.ts";
import { createKingdeeTools } from "../lib/agent/mcp-tools/kingdee-tools.ts";

type MockTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
const sdkMock = {
  tool: (name: string, _desc: string, _schema: unknown, handler: MockTool["handler"]): MockTool => ({ name, handler })
};

export const financeCardsTestPromise = (async () => {
  // ── AC7: 报销卡片数据整形 ──
  const reimRow = (invoiceNo: string, warnings: string[]) => ({
    employeeName: "张三", expenseDate: "2026-06-01", invoiceNo, category: "差旅", amount: 1200, warnings
  });
  const reim = parseReimbursementStructured({
    results: [reimRow("INV-2", ["历史重复报销"]), reimRow("INV-1", [])],
    summary: "共 2 条,1 条有异常",
    abnormalCount: 1
  });
  assert.ok(reim, "AC7 FAIL: 合法 payload 应解析成功");
  assert.equal(reim!.rows[0].invoiceNo, "INV-2", "AC7 FAIL: 必须保留工具的风险排序(异常在前)");
  assert.deepEqual(reim!.rows[0].warnings, ["历史重复报销"]);
  assert.equal(reim!.abnormalCount, 1);

  const brokenRow = { employeeName: "李四", expenseDate: "2026-06-01", invoiceNo: "X", category: "餐饮" };
  assert.equal(parseReimbursementStructured({ results: [brokenRow] }), null, "AC7 FAIL: 缺 amount 必须整体回退 null");
  assert.equal(parseReimbursementStructured(null), null);
  const computed = parseReimbursementStructured({ results: [reimRow("A", ["超标"]), reimRow("B", [])] });
  assert.equal(computed!.abnormalCount, 1, "AC7 FAIL: 缺 abnormalCount 时按行重算");

  // ── AC8: 金蝶工具返回 structuredContent ──
  const tools = createKingdeeTools(sdkMock) as MockTool[];
  const exportDraft = tools.find((t) => t.name === "export_kingdee_draft")!;
  const validate = tools.find((t) => t.name === "validate_kingdee_voucher")!;

  const draftResult = await exportDraft.handler({
    company: "测试公司", period: "2026-06",
    entries: [{ date: "2026-06-10", summary: "报销差旅费", debitAccount: "6602.01", debitAmount: 1200, creditAccount: "1002", creditAmount: 1200, attachmentCount: 2 }]
  }) as { structuredContent?: unknown };
  assert.ok(draftResult.structuredContent, "AC8 FAIL: export_kingdee_draft 应返回 structuredContent");
  const draftData = parseVoucherDraftStructured(draftResult.structuredContent);
  assert.ok(draftData, "AC8 FAIL: structuredContent 应能被严格解析");
  assert.equal(draftData!.balanced, true);
  assert.equal(draftData!.simulated, true, "AC8 FAIL: 模拟模式标记必须透出");
  assert.equal(draftData!.entries.length, 1);
  assert.equal(draftData!.entries[0].debitAccountName, "管理费用-差旅费", "AC8 FAIL: 科目名称应已富化");

  const validateResult = await validate.handler({
    voucherJson: JSON.stringify({ voucherDraft: { entries: [], totalDebit: 0, totalCredit: 0 } })
  }) as { structuredContent?: unknown };
  const validation = parseVoucherValidationStructured(validateResult.structuredContent);
  assert.ok(validation, "AC8 FAIL: validate 应返回可解析的 structuredContent");
  assert.equal(validation!.valid, false);
  assert.ok(validation!.errors.some((e) => e.includes("借方总金额")), "AC8 FAIL: 错误清单必须保留");

  // 严格回退
  assert.equal(parseVoucherDraftStructured({ id: "x" }), null, "AC8 FAIL: 字段残缺必须回退 null");
  assert.equal(parseVoucherValidationStructured({ valid: "yes" }), null);

  // ── AC9: 卡片统一分发 ──
  const { ToolResultCard } = await import("../app/components/tool-cards.tsx");
  const payrollStructured = {
    results: [{ employeeName: "张三", grossPay: 1, socialInsurance: 0, housingFund: 0, specialDeduction: 0, taxCurrent: 0, netPay: 1 }],
    failures: [], coldStarts: []
  };
  assert.ok(ToolResultCard({ name: "mcp__finance_worker__calculate_payroll_batch", structured: payrollStructured }), "AC9 FAIL: 工资卡");
  assert.ok(ToolResultCard({ name: "mcp__finance_worker__check_reimbursement_batch", structured: { results: [reimRow("I", [])] } }), "AC9 FAIL: 报销卡");
  assert.ok(ToolResultCard({ name: "mcp__kingdee_worker__export_kingdee_draft", structured: draftResult.structuredContent }), "AC9 FAIL: 凭证卡");
  assert.ok(ToolResultCard({ name: "mcp__kingdee_worker__validate_kingdee_voucher", structured: validateResult.structuredContent }), "AC9 FAIL: 校验卡");
  assert.equal(ToolResultCard({ name: "mcp__finance_worker__tax_calculator", structured: { any: 1 } }), null, "AC9 FAIL: 未注册工具应返回 null");
  assert.equal(ToolResultCard({ name: "mcp__finance_worker__calculate_payroll_batch", structured: null }), null, "AC9 FAIL: 无 structured 应返回 null");
  assert.equal(ToolResultCard({ name: "mcp__finance_worker__calculate_payroll_batch", structured: { results: [{ bad: true }] } }), null, "AC9 FAIL: 解析失败必须回退 null");

  console.log("finance-cards: all 3 checks passed ✓");
})();
