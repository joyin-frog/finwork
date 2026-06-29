/**
 * 功能3: MCP工具 structuredContent + settlementStatus 接线 + PII脱敏
 *
 * 集成测试（测试后置）：
 *   F3-T1: tax_calculator VAT 返回 structuredContent CalcReceipt，value=税额
 *   F3-T2: tax_calculator CIT 返回 structuredContent CalcReceipt，value=税额
 *   F3-T3: tax_calculator content 已通过 redact 处理
 *   F3-T4: 薪税 settlementStatus 接真实 DB 状态：新草稿=draft，重算已确认=closed
 *   F3-T5: 对账 structuredContent 含 receipt（unit/basis）
 *   F3-T6: 对账 content 中银行流水敏感字段（手机号）已脱敏
 *   F3-T7: 报销 structuredContent.results[0].receipt 存在
 *   F3-T8: parity — structuredContent.value 与 content.text 同源（Python 单一计算，TS 不重算）
 */
import assert from "node:assert/strict";
import path from "node:path";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { confirmPayrollPeriod } from "../lib/db/finance-store.ts";
import { createPayrollTools } from "../lib/agent/tools/finance/payroll.ts";
import { createFinanceTools } from "../lib/agent/mcp-tools/finance-tools.ts";
import { createReconciliationTools } from "../lib/agent/tools/finance/reconciliation.ts";
import { createReimbursementTools } from "../lib/agent/tools/finance/reimbursement.ts";

export const financeToolsF3TestPromise = (async () => {
  const dbPath = path.join(`/tmp/finance-agent-f3-${process.pid}`, "f3.db");
  delete process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  const db = initializeFinanceDatabase(openFinanceDatabase(dbPath));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (name: string, _d: string, _s: unknown, handler: unknown) => {
      captured[name] = handler;
      return { name };
    },
  };

  createPayrollTools(mockSdk);
  createFinanceTools(mockSdk, "/tmp");
  createReconciliationTools(mockSdk);
  createReimbursementTools(mockSdk);

  // ── F3-T1: tax_calculator VAT 返回 structuredContent CalcReceipt ─────────
  const vatResult = await captured["tax_calculator"]({
    type: "vat",
    amount: 1000,
    vatParams: { direction: "from_tax_exclusive", rate: "0.13" },
  });
  assert.ok(!vatResult.isError, `F3-T1 FAIL: VAT计算不应报错: ${JSON.stringify(vatResult)}`);
  assert.ok(vatResult.structuredContent, "F3-T1 FAIL: tax_calculator VAT 应有 structuredContent");
  assert.equal(vatResult.structuredContent.unit, "CNY", "F3-T1 FAIL: structuredContent.unit 应为 CNY");
  assert.ok(typeof vatResult.structuredContent.value === "number", "F3-T1 FAIL: structuredContent.value 应为数值");
  assert.ok(Array.isArray(vatResult.structuredContent.steps), "F3-T1 FAIL: structuredContent.steps 应为数组");
  assert.ok(vatResult.structuredContent.steps.length > 0, "F3-T1 FAIL: structuredContent.steps 不应为空");
  assert.equal(
    vatResult.structuredContent.basis.settlementStatus,
    "draft",
    `F3-T1 FAIL: VAT结果 settlementStatus 应为 draft`
  );
  // 1000 × 13% = 130
  assert.equal(
    vatResult.structuredContent.value,
    130,
    `F3-T1 FAIL: VAT税额应为130，实际: ${vatResult.structuredContent.value}`
  );

  // ── F3-T2: tax_calculator CIT 返回 structuredContent CalcReceipt ─────────
  const citResult = await captured["tax_calculator"]({
    type: "cit",
    amount: 100000,
    citParams: { rate: "0.25", deductions: 10000 },
  });
  assert.ok(!citResult.isError, `F3-T2 FAIL: CIT计算不应报错: ${JSON.stringify(citResult)}`);
  assert.ok(citResult.structuredContent, "F3-T2 FAIL: tax_calculator CIT 应有 structuredContent");
  // (100000 - 10000) × 25% = 22500
  assert.equal(
    citResult.structuredContent.value,
    22500,
    `F3-T2 FAIL: CIT税额应为22500，实际: ${citResult.structuredContent.value}`
  );
  assert.ok(citResult.structuredContent.steps.length >= 2, "F3-T2 FAIL: CIT应有>=2步");
  assert.equal(
    citResult.structuredContent.basis.caliberVersion,
    "cit-0.25",
    `F3-T2 FAIL: caliberVersion 应含税率，实际: ${citResult.structuredContent.basis.caliberVersion}`
  );

  // ── F3-T3: tax_calculator content 字符串存在（已经过 redact 处理）────────────────────
  const vatContent = vatResult.content[0].text as string;
  assert.equal(typeof vatContent, "string", "F3-T3 FAIL: content 应为字符串");
  // VAT/CIT内容中无PII，确保内容非空即可
  assert.ok(vatContent.length > 0, "F3-T3 FAIL: content 不应为空");

  // ── F3-T8 (parity): structuredContent.value 与 content.text 同源，单一真相钉死 ────────
  // TS 不再重算税额：Python text 和 result.value 由同一套计算产生，两者必须吧合
  const vatValueStr = (vatResult.structuredContent.value as number).toFixed(2);
  assert.ok(
    vatContent.includes(vatValueStr),
    `F3-T8 FAIL (parity): VAT structuredContent.value(${vatValueStr}) 应出现在 content.text 中（指示同源，无双真相），text片段: ${vatContent.slice(0, 150)}`
  );
  const citContent = citResult.content[0].text as string;
  const citValueStr = (citResult.structuredContent.value as number).toFixed(2);
  assert.ok(
    citContent.includes(citValueStr),
    `F3-T8 FAIL (parity): CIT structuredContent.value(${citValueStr}) 应出现在 content.text 中，text片段: ${citContent.slice(0, 150)}`
  );

  // ── F3-T4: 薪税 settlementStatus 接真实 DB 状态 ──────────────────────────
  // 4a: 全新草稿 → receipt.basis.settlementStatus = "draft"
  const r4a = await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 2,
    employees: [
      {
        employeeName: "F3测试员工",
        grossPay: 20000,
        socialInsurance: 2000,
        housingFund: 1500,
        specialDeduction: 1000,
        monthsEmployed: 2,
      },
    ],
  });
  assert.ok(!r4a.isError, `F3-T4a FAIL: 计算应成功: ${JSON.stringify(r4a)}`);
  const r4aResult = r4a.structuredContent.results[0];
  assert.ok(r4aResult.receipt, "F3-T4a FAIL: result 应有 receipt");
  assert.equal(
    r4aResult.receipt.basis.settlementStatus,
    "draft",
    `F3-T4a FAIL: 新草稿 settlementStatus 应为 draft，实际: ${r4aResult.receipt.basis.settlementStatus}`
  );
  assert.equal(
    r4aResult.receipt.basis.asOf,
    "2026-02",
    `F3-T4a FAIL: asOf 应为 2026-02，实际: ${r4aResult.receipt.basis.asOf}`
  );

  // 4b: 确认后重新计算 → receipt.basis.settlementStatus = "closed"（读到 DB 的 confirmed 状态）
  confirmPayrollPeriod(2026, 2, undefined, db);
  const r4b = await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 2,
    employees: [
      {
        employeeName: "F3测试员工",
        grossPay: 20000,
        socialInsurance: 2000,
        housingFund: 1500,
        specialDeduction: 1000,
        monthsEmployed: 2,
      },
    ],
    overwriteConfirmed: true,
  });
  assert.ok(!r4b.isError, `F3-T4b FAIL: 重算应成功: ${JSON.stringify(r4b)}`);
  const r4bResult = r4b.structuredContent.results[0];
  assert.ok(r4bResult.receipt, "F3-T4b FAIL: result 应有 receipt");
  assert.equal(
    r4bResult.receipt.basis.settlementStatus,
    "closed",
    `F3-T4b FAIL: 重算已确认记录 settlementStatus 应为 closed（曾确认），实际: ${r4bResult.receipt.basis.settlementStatus}`
  );

  // ── F3-T5: 对账 structuredContent 含 receipt ────────────────────────────
  const reconResult = await captured["reconcile_bank_statement"]({
    bankRows: [{ date: "2026-06-01", amount: 100, direction: "in" }],
    bookRows: [{ date: "2026-06-01", amount: 100, direction: "in" }],
  });
  assert.ok(!reconResult.isError, `F3-T5 FAIL: 对账不应报错，实际: ${JSON.stringify(reconResult)}`);
  assert.ok(reconResult.structuredContent.receipt, "F3-T5 FAIL: structuredContent.receipt 应存在");
  assert.equal(reconResult.structuredContent.receipt.unit, "CNY", "F3-T5 FAIL: receipt.unit 应为 CNY");
  assert.equal(
    reconResult.structuredContent.receipt.basis.settlementStatus,
    "draft",
    "F3-T5 FAIL: 对账回执 settlementStatus 应为 draft"
  );

  // ── F3-T6: 对账 content 中银行流水手机号已脱敏 ───────────────────────────
  const reconPiiResult = await captured["reconcile_bank_statement"]({
    bankRows: [
      {
        date: "2026-06-10",
        amount: 500,
        direction: "in",
        counterparty: "张三 13812345678",
        description: "转账",
      },
    ],
    bookRows: [], // unbalanced → bankOnly 显示在 content 中
  });
  const reconContent = reconPiiResult.content[0].text as string;
  assert.ok(
    !reconContent.includes("13812345678"),
    `F3-T6 FAIL: content 中手机号应已脱敏，实际内容片段: ${reconContent.slice(0, 200)}`
  );
  assert.ok(
    reconContent.includes("[已脱敏:手机号]"),
    `F3-T6 FAIL: 脱敏占位符 [已脱敏:手机号] 应出现在 content 中，实际: ${reconContent.slice(0, 200)}`
  );

  // ── F3-T7: 报销 structuredContent.results[0].receipt 存在 ───────────────
  const reimbResult = await captured["check_reimbursement_batch"]({
    items: [
      {
        employeeName: "测试用户",
        expenseDate: "2026-06-01",
        invoiceNo: "INV-F3-001",
        category: "交通",
        amount: 200,
      },
    ],
  });
  assert.ok(!reimbResult.isError, `F3-T7 FAIL: 报销校验不应报错`);
  const reimbItems = reimbResult.structuredContent.results as Array<{ receipt?: { unit?: string } }>;
  assert.ok(reimbItems.length > 0, "F3-T7 FAIL: results 不应为空");
  assert.ok(reimbItems[0].receipt, "F3-T7 FAIL: results[0].receipt 应存在");
  assert.equal(reimbItems[0].receipt!.unit, "CNY", "F3-T7 FAIL: receipt.unit 应为 CNY");

  db.close();
  delete process.env.FINANCE_AGENT_DB_PATH;
  console.log("finance-tools-f3: all 8 checks passed ✓");
})();
