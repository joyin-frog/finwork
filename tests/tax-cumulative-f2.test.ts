/**
 * 功能2-链路1: 薪税 CalcReceipt 补齐 source / settlementStatus / asOf
 *
 * 严格 TDD（CLAUDE.md §5）:
 *   F2-T1 在实现前 RED — calculateCumulativePayroll 的 settlementStatus 硬编码 "draft"，
 *   source 硬编码 []，两个断言都会失败。
 *   实现后（CumulativePayrollInput 加字段 + calculateCumulativePayroll 透传）GREEN。
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  calculateCumulativePayroll,
  buildTaxCumulativeReceipt,
} from "../lib/domain/tax-cumulative.ts";
import type { CumulativeTaxDetail } from "../lib/domain/tax-cumulative.ts";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { confirmPayrollPeriod } from "../lib/db/finance-store.ts";
import { createPayrollTools } from "../lib/agent/tools/finance/payroll.ts";

/** 纯 TS 用的 mock detail，不走 Python */
const mockDetail: CumulativeTaxDetail = {
  grossCum: 15000,
  basicDeductionCum: 5000,
  socialCum: 1500,
  fundCum: 500,
  specialCum: 0,
  taxableIncomeCum: 8000,
  bracketRate: 0.03,
  quickDeduction: 0,
  taxDueCum: 240,
  taxWithheldPriorCum: 0,
  formula: "(15000-5000-1500-500)×3%-0=240",
  taxConfigVersion: "2026-standard-v1",
};

export const taxCumulativeF2TestPromise = (async () => {
  // ── F2-T1: calculateCumulativePayroll 传入 settlementStatus / source → 回执正确 ──
  // RED 证明: 实现前 receipt.basis.settlementStatus === "draft"（硬编码），
  //           source === []（硬编码），两处断言均失败。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r1 = calculateCumulativePayroll({
    employeeName: "张三",
    grossPay: 15000,
    socialInsurance: 1500,
    housingFund: 500,
    specialDeduction: 0,
    monthsEmployed: 6,
    asOf: "2026-06",
    settlementStatus: "closed",
    source: [{ file: "payroll-2026-06.xlsx", recordCount: 1 }],
  } as unknown as Parameters<typeof calculateCumulativePayroll>[0]);

  assert.equal(
    r1.receipt.basis.settlementStatus,
    "closed",
    "F2-T1 FAIL: settlementStatus 应为 closed（需在 calculateCumulativePayroll 中透传 input.settlementStatus）"
  );
  assert.equal(r1.receipt.source.length, 1, "F2-T1 FAIL: source 应有 1 项");
  assert.equal(
    r1.receipt.source[0].file,
    "payroll-2026-06.xlsx",
    "F2-T1 FAIL: source[0].file"
  );
  assert.equal(
    r1.receipt.source[0].recordCount,
    1,
    "F2-T1 FAIL: source[0].recordCount"
  );
  assert.equal(r1.receipt.basis.asOf, "2026-06", "F2-T1 FAIL: asOf");

  // ── F2-T2: 默认 settlementStatus 保持 "draft"，默认 source 为空（不破坏现有行为）──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r2 = calculateCumulativePayroll({
    employeeName: "李四",
    grossPay: 10000,
    socialInsurance: 1000,
    housingFund: 500,
    specialDeduction: 0,
    monthsEmployed: 1,
    asOf: "2026-06",
  } as unknown as Parameters<typeof calculateCumulativePayroll>[0]);
  assert.equal(
    r2.receipt.basis.settlementStatus,
    "draft",
    "F2-T2 FAIL: 默认应为 draft（向后兼容）"
  );
  assert.deepEqual(r2.receipt.source, [], "F2-T2 FAIL: 默认 source 应为空数组");

  // ── F2-T3: buildTaxCumulativeReceipt 多来源 source（纯 TS，无 Python）──
  const r3 = buildTaxCumulativeReceipt(mockDetail, {
    taxCurrent: 240,
    asOf: "2026-06",
    settlementStatus: "draft",
    source: [
      { file: "payroll-2026-06.xlsx", ref: "B2", recordCount: 1 },
      { ref: "prior-ytd", recordCount: 5 },
    ],
  });
  assert.equal(r3.source.length, 2, "F2-T3 FAIL: 2 来源");
  assert.equal(r3.source[1].ref, "prior-ytd", "F2-T3 FAIL: source[1].ref");
  assert.equal(r3.source[1].recordCount, 5, "F2-T3 FAIL: source[1].recordCount");

  // ── F2-T4: caliberVersion 来自 detail.taxConfigVersion ──
  assert.equal(
    r3.basis.caliberVersion,
    "2026-standard-v1",
    "F2-T4 FAIL: caliberVersion 应来自 taxConfigVersion"
  );

  // ── F2-T5 ~ F2-T7: payroll source 产品语言条目（WP4a-PL1 ~ PL3）──────────
  // 测工具层(payroll.ts)拼装的 receipt.source 是否包含产品语言条目
  // RED: 当前 source 只有 [{ref:"payroll-YYYY-MM",recordCount:1}]，无产品语言条目
  const plDbPath = path.join(`/tmp/finance-agent-payroll-f2-${process.pid}`, "f2-payroll.db");
  delete process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = plDbPath;
  const plDb = initializeFinanceDatabase(openFinanceDatabase(plDbPath));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plCapture: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plMock: any = { tool: (name: string, _d: string, _s: unknown, h: any) => { plCapture[name] = h; return { name }; } };
  createPayrollTools(plMock);

  // F2-T5: ytd 提供（冷启动分支）→ source 应含"调用方提供的年初累计"
  const rPl1 = await plCapture["calculate_payroll_batch"]({
    year: 2026,
    month: 5,
    employees: [{
      employeeName: "F2员工甲",
      grossPay: 20000,
      socialInsurance: 2000,
      housingFund: 1000,
      specialDeduction: 0,
      monthsEmployed: 5,
      ytd: { grossCum: 80000, socialCum: 8000, fundCum: 4000, specialCum: 0, taxWithheldCum: 2000 },
    }],
  });
  assert.ok(!rPl1.isError, `F2-T5 FAIL: 工具报错=${JSON.stringify(rPl1)}`);
  const srcPl1 = rPl1.structuredContent.results[0]?.receipt?.source ?? [];
  assert.ok(
    srcPl1.some((s: { ref?: string }) => s.ref?.includes("调用方提供的年初累计")),
    `F2-T5 FAIL: 冷启动(ytd 提供)source 应含"调用方提供的年初累计"，实际: ${JSON.stringify(srcPl1)}`
  );

  // F2-T6: 接力分支(有历史已确认记录) → source 应含"接力 YYYY-MM 已确认记录"
  // 先算并确认 4 月
  await plCapture["calculate_payroll_batch"]({
    year: 2026,
    month: 4,
    employees: [{
      employeeName: "F2员工乙",
      grossPay: 15000,
      socialInsurance: 1500,
      housingFund: 750,
      specialDeduction: 0,
      monthsEmployed: 4,
    }],
  });
  confirmPayrollPeriod(2026, 4, undefined, plDb);
  // 算 5 月，不传 ytd → 接力 4 月
  const rPl2 = await plCapture["calculate_payroll_batch"]({
    year: 2026,
    month: 5,
    employees: [{
      employeeName: "F2员工乙",
      grossPay: 15000,
      socialInsurance: 1500,
      housingFund: 750,
      specialDeduction: 0,
    }],
  });
  assert.ok(!rPl2.isError, `F2-T6 FAIL: 工具报错=${JSON.stringify(rPl2)}`);
  const srcPl2 = rPl2.structuredContent.results[0]?.receipt?.source ?? [];
  assert.ok(
    srcPl2.some((s: { ref?: string }) => s.ref?.includes("接力") && s.ref?.includes("2026-04")),
    `F2-T6 FAIL: 接力分支 source 应含"接力 2026-04 已确认记录"，实际: ${JSON.stringify(srcPl2)}`
  );

  // F2-T7: 纯冷启动（无 ytd、无历史记录）→ source 应含"调用方提供的年初累计"
  const rPl3 = await plCapture["calculate_payroll_batch"]({
    year: 2026,
    month: 6,
    employees: [{
      employeeName: "F2员工丙",
      grossPay: 10000,
      socialInsurance: 1000,
      housingFund: 500,
      specialDeduction: 0,
      monthsEmployed: 1,
    }],
  });
  assert.ok(!rPl3.isError, `F2-T7 FAIL: 工具报错=${JSON.stringify(rPl3)}`);
  const srcPl3 = rPl3.structuredContent.results[0]?.receipt?.source ?? [];
  assert.ok(
    srcPl3.some((s: { ref?: string }) => s.ref?.includes("调用方提供的年初累计")),
    `F2-T7 FAIL: 纯冷启动 source 应含"调用方提供的年初累计"，实际: ${JSON.stringify(srcPl3)}`
  );

  plDb.close();
  delete process.env.FINANCE_AGENT_DB_PATH;

  console.log("tax-cumulative-f2: all 4 checks passed ✓");
})();
