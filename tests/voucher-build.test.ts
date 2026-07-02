import assert from "node:assert/strict";
import { buildVoucherLines } from "../lib/domain/voucher-build.ts";

// 多行凭证构造 + 预借款冲销。核心开关:单据「原借款」栏有金额→冲销分录,空→普通分录。
// 借贷必平衡(整数分,不丢浮点)。费用行维度=部门,冲销行维度=员工。
export const voucherBuildTestPromise = (async () => {
  const expenses = [
    { summary: "住宿费", account: "6602.04", accountName: "管理费用-旅差费", amountYuan: 1377 },
    { summary: "餐饮费", account: "6602.04", accountName: "管理费用-旅差费", amountYuan: 2323 },
  ];
  const payment = { code: "1002", name: "银行存款" };
  const advanceAcc = { code: "1221.03", name: "其他应收款-个人往来" };

  // ── B1: 普通凭证(无借款)→ 借费用两行 + 贷银行一行,平衡 ──
  const plain = buildVoucherLines({ expenses, paymentAccount: payment, departmentName: "综合部" });
  assert.equal(plain.balanced, true, "B1 FAIL: 应借贷平衡");
  assert.equal(plain.lines.length, 3, "B1 FAIL: 2 费用借 + 1 银行贷 = 3 行");
  assert.equal(plain.totalDebit, 3700, "B1 FAIL: 借方合计 3700");
  assert.equal(plain.totalCredit, 3700, "B1 FAIL: 贷方合计 3700");
  assert.equal(plain.lines[0].debitYuan, 1377, "B1 FAIL: 首行借方");
  assert.equal(plain.lines[0].dimensionValue, "综合部", "B1 FAIL: 费用行维度=部门");
  assert.equal(plain.lines[2].creditYuan, 3700, "B1 FAIL: 银行贷方=合计");
  assert.ok(plain.lines[2].debitYuan == null, "B1 FAIL: 贷方行不应有借方额");

  // ── B2: 冲销·应退款(借5000花3700)→ 借费用 + 借银行退回1300 / 贷其他应收款5000 ──
  const refund = buildVoucherLines({
    expenses, paymentAccount: payment, departmentName: "综合部",
    advanceYuan: 5000, advanceAccount: advanceAcc, payeeName: "胡明班",
  });
  assert.equal(refund.balanced, true, "B2 FAIL: 应平衡");
  assert.equal(refund.totalDebit, 5000, "B2 FAIL: 借方=费用3700+退回1300=5000");
  assert.equal(refund.totalCredit, 5000, "B2 FAIL: 贷方=其他应收款5000");
  const advLine = refund.lines.find((l) => l.account === "1221.03");
  assert.equal(advLine?.creditYuan, 5000, "B2 FAIL: 冲销贷其他应收款=原借款5000");
  assert.equal(advLine?.dimensionValue, "胡明班", "B2 FAIL: 冲销行维度=员工=报销人");
  const refundLine = refund.lines.find((l) => l.account === "1002" && l.debitYuan);
  assert.equal(refundLine?.debitYuan, 1300, "B2 FAIL: 退回款借银行1300");

  // ── B3: 冲销·应补款(借5000花6000)→ 贷其他应收款5000 + 贷银行补付1000 ──
  const bigExp = [{ summary: "住宿费", account: "6602.04", amountYuan: 6000 }];
  const topup = buildVoucherLines({
    expenses: bigExp, paymentAccount: payment,
    advanceYuan: 5000, advanceAccount: advanceAcc, payeeName: "张三",
  });
  assert.equal(topup.balanced, true, "B3 FAIL: 应平衡");
  assert.equal(topup.totalDebit, 6000, "B3 FAIL: 借方=费用6000");
  assert.equal(topup.totalCredit, 6000, "B3 FAIL: 贷方=其他应收款5000+补付1000");
  const topupLine = topup.lines.find((l) => l.account === "1002" && l.creditYuan);
  assert.equal(topupLine?.creditYuan, 1000, "B3 FAIL: 补付款贷银行1000");

  // ── B4: 冲销·恰好(借3700花3700)→ 无差额行 ──
  const exact = buildVoucherLines({
    expenses, paymentAccount: payment, advanceYuan: 3700, advanceAccount: advanceAcc, payeeName: "李四",
  });
  assert.equal(exact.balanced, true, "B4 FAIL: 应平衡");
  assert.equal(exact.lines.length, 3, "B4 FAIL: 2 费用 + 1 冲销 = 3 行,无差额行");
  assert.ok(!exact.lines.some((l) => l.account === "1002"), "B4 FAIL: 恰好时不应有银行行");

  // ── B5: 浮点安全(1377.55+2322.45=3700)──
  const cents = buildVoucherLines({
    expenses: [
      { summary: "A", account: "6602.04", amountYuan: 1377.55 },
      { summary: "B", account: "6602.04", amountYuan: 2322.45 },
    ],
    paymentAccount: payment,
  });
  assert.equal(cents.balanced, true, "B5 FAIL: 分位应平衡");
  assert.equal(cents.totalDebit, 3700, "B5 FAIL: 1377.55+2322.45=3700 不丢分");

  console.log("voucher-build: 普通/冲销退款/冲销补款/恰好/浮点 五种分录均平衡 ✓");
})();
