import assert from "node:assert/strict";
import { buildVoucherLines } from "../lib/domain/voucher-build.ts";

// A. income 方向 + payerBankName 维度 + expense 老路径回归
export const voucherBuildIncomeTestPromise = (async () => {
  const bankPayment = { code: "1002.01", name: "银行存款-浦发" };

  // ── BI1: income 方向 – 结息 26.34 元 → 借银行存款/贷利息收入 ──
  const interest = buildVoucherLines({
    expenses: [{ summary: "利息收入", account: "6603.02", accountName: "财务费用-利息收入", amountYuan: 26.34 }],
    paymentAccount: bankPayment,
    direction: "income",
    payerBankName: "浦发银行闸北支行",
  });
  assert.equal(interest.balanced, true, "BI1 FAIL: income 结息应借贷平衡");
  assert.equal(interest.lines.length, 2, "BI1 FAIL: 1 收入行 + 1 银行行 = 2 行");
  // 收入行(利息收入)必须在贷方
  const creditLine = interest.lines.find((l) => l.account === "6603.02");
  assert.ok(creditLine, "BI1 FAIL: 应有利息收入行");
  assert.ok(creditLine!.creditYuan != null, "BI1 FAIL: 利息收入行应在贷方");
  assert.ok(creditLine!.debitYuan == null, "BI1 FAIL: 利息收入行不应有借方金额");
  assert.equal(creditLine!.creditYuan, 26.34, "BI1 FAIL: 贷方=26.34");
  // 银行行(1002.01)必须在借方
  const debitLine = interest.lines.find((l) => l.account === "1002.01");
  assert.ok(debitLine, "BI1 FAIL: 应有银行行");
  assert.ok(debitLine!.debitYuan != null, "BI1 FAIL: 银行行应在借方");
  assert.ok(debitLine!.creditYuan == null, "BI1 FAIL: 银行行不应有贷方金额");
  assert.equal(debitLine!.debitYuan, 26.34, "BI1 FAIL: 借方=26.34");
  // 摘要包含"收款"而非"付款"
  assert.ok(debitLine!.summary.includes("收款"), "BI1 FAIL: income 摘要应包含「收款」");
  assert.ok(!debitLine!.summary.includes("付款"), "BI1 FAIL: income 摘要不应含「付款」");

  // ── BI2: income + payerBankName → 银行行维度填 payerBankName ──
  // paymentAccount 带 dimension hint(银行账号)情形:此处测 payerBankName 传播
  const withBank = buildVoucherLines({
    expenses: [{ summary: "利息收入", account: "6603.02", amountYuan: 100 }],
    paymentAccount: { code: "1002.01", name: "银行存款" },
    direction: "income",
    payerBankName: "建设银行浦东支行",
    paymentAccountDimension: "银行账号",
  });
  const bankLine = withBank.lines.find((l) => l.account === "1002.01");
  assert.ok(bankLine, "BI2 FAIL: 应有银行行");
  assert.equal(bankLine!.dimensionType, "银行账号", "BI2 FAIL: 维度类型=银行账号");
  assert.equal(bankLine!.dimensionValue, "建设银行浦东支行", "BI2 FAIL: 维度值=payerBankName");

  // ── BI3: income + payerBankName 缺失 → 银行行维度为空,绝不默认填任何银行 ──
  const noBank = buildVoucherLines({
    expenses: [{ summary: "利息收入", account: "6603.02", amountYuan: 100 }],
    paymentAccount: { code: "1002.01", name: "银行存款" },
    direction: "income",
    paymentAccountDimension: "银行账号",
    // 不传 payerBankName
  });
  const noBankLine = noBank.lines.find((l) => l.account === "1002.01");
  assert.ok(noBankLine, "BI3 FAIL: 应有银行行");
  assert.ok(noBankLine!.dimensionValue == null || noBankLine!.dimensionValue === "", "BI3 FAIL: payerBankName 缺失时维度值必须为空");

  // ── BI4: expense 老路径回归(普通付款,不受 income 影响)──
  const plain = buildVoucherLines({
    expenses: [{ summary: "住宿费", account: "6602.04", accountName: "管理费用-旅差费", amountYuan: 3700 }],
    paymentAccount: { code: "1002", name: "银行存款" },
    departmentName: "综合部",
  });
  assert.equal(plain.balanced, true, "BI4 FAIL: expense 老路径应平衡");
  const plainExpense = plain.lines.find((l) => l.account === "6602.04");
  assert.ok(plainExpense!.debitYuan != null, "BI4 FAIL: expense 行仍在借方");
  const plainBank = plain.lines.find((l) => l.account === "1002");
  assert.ok(plainBank!.creditYuan != null, "BI4 FAIL: 银行行仍在贷方");
  assert.ok(plainBank!.summary.includes("付款"), "BI4 FAIL: expense 摘要仍是付款");

  // ── BI5: income 浮点安全(26.34 分位平衡)──
  const floatCheck = buildVoucherLines({
    expenses: [{ summary: "利息收入", account: "6603.02", amountYuan: 26.34 }],
    paymentAccount: { code: "1002.01", name: "银行存款" },
    direction: "income",
  });
  assert.equal(floatCheck.balanced, true, "BI5 FAIL: income 浮点 26.34 应平衡");
  assert.equal(floatCheck.totalDebit, 26.34, "BI5 FAIL: 借方合计 26.34");
  assert.equal(floatCheck.totalCredit, 26.34, "BI5 FAIL: 贷方合计 26.34");

  console.log("voucher-build-income: income 方向/payerBankName/缺失留空/expense 回归/浮点 ✓");
})();
