// 薪税结构化差异复核——纯函数层。
// 无 DB 调用、无副作用；供 diff_payroll_period 工具和单测直接调用。
// 精度：delta = Math.round(a*100 - b*100)/100（先各自乘 100 再相减，避免 (a-b)*100 尾差）。

import type { StoredPayrollRecord } from "@/lib/db/finance-store";

/** 单字段差异（单位：元）*/
export type PayrollDiffField = {
  prior: number;
  current: number;
  /** delta = Math.round(current*100 - prior*100)/100 */
  delta: number;
};

/**
 * 单员工差异行。
 * - `flags` 可含 `"new"`（本月有、上月 confirmed 无）或 `"tax_config_changed"`（税率版本不同）。
 * - `maxAbsDelta`：该员工所有字段 |delta| 的最大值，供排序。
 * - `changed`：maxAbsDelta > 0。
 */
export type PayrollDiffRow = {
  employeeName: string;
  fields: {
    grossPay: PayrollDiffField;
    socialInsurance: PayrollDiffField;
    housingFund: PayrollDiffField;
    specialDeduction: PayrollDiffField;
    taxCurrent: PayrollDiffField;
    netPay: PayrollDiffField;
  };
  maxAbsDelta: number;
  changed: boolean;
  flags: string[];
};

/**
 * 整期差异结果。
 * - `rows`：有 prior 的员工列表（new 优先，再按 maxAbsDelta 降序）。
 * - `newEmployees`：current 有、priorByName 无的员工名列表。
 * - `dropped`：priorRoster 有、current 无的员工名列表（嫌疑离职或漏算）。
 * - `comparedFromPeriod`：格式 "YYYY 年 MM 月"；若无 prior 期间则 null。
 */
export type PayrollDiffResult = {
  rows: PayrollDiffRow[];
  newEmployees: string[];
  dropped: string[];
  comparedFromPeriod: string | null;
};

/** 精度安全的两位小数差值（先各自乘 100 再相减，比 (a-b)*100 更稳） */
function delta2(current: number, prior: number): number {
  return Math.round(current * 100 - prior * 100) / 100;
}

/**
 * 计算本月草稿与上月已确认之间的逐人逐字段差异。
 *
 * @param current      本月工资记录列表（含草稿/已确认）
 * @param priorByName  上月已确认记录 Map<employeeName, record>（与 priorRoster 同源期间）
 * @param priorRoster  上月已确认花名册（employeeName 列表；与 priorByName 同源期间）
 * @param comparedFromPeriod  已格式化的 prior 期间字符串（如 "2025 年 12 月"），或 null
 */
export function computePayrollDiff(
  current: StoredPayrollRecord[],
  priorByName: Map<string, StoredPayrollRecord>,
  priorRoster: string[],
  comparedFromPeriod: string | null
): PayrollDiffResult {
  const currentNames = new Set(current.map((r) => r.employeeName));

  const newEmployees: string[] = [];
  const rows: PayrollDiffRow[] = [];

  for (const rec of current) {
    const prior = priorByName.get(rec.employeeName);

    if (!prior) {
      // 新增：本月有、上月 confirmed 无
      newEmployees.push(rec.employeeName);
      // 也放入 rows，以 prior=0 计算完整 delta，方便卡片渲染
      const zeroField = (cur: number): PayrollDiffField => ({
        prior: 0,
        current: cur,
        delta: delta2(cur, 0)
      });
      const fields = {
        grossPay:        zeroField(rec.grossPay),
        socialInsurance: zeroField(rec.socialInsurance),
        housingFund:     zeroField(rec.housingFund),
        specialDeduction:zeroField(rec.specialDeduction),
        taxCurrent:      zeroField(rec.taxCurrent),
        netPay:          zeroField(rec.netPay),
      };
      const maxAbsDelta = Math.max(...Object.values(fields).map((f) => Math.abs(f.delta)));
      rows.push({
        employeeName: rec.employeeName,
        fields,
        maxAbsDelta,
        changed: maxAbsDelta > 0,
        flags: ["new"],
      });
      continue;
    }

    // 有 prior——算 6 字段 delta
    const mk = (cur: number, priorVal: number): PayrollDiffField => ({
      prior: priorVal,
      current: cur,
      delta: delta2(cur, priorVal),
    });

    const fields = {
      grossPay:        mk(rec.grossPay,        prior.grossPay),
      socialInsurance: mk(rec.socialInsurance, prior.socialInsurance),
      housingFund:     mk(rec.housingFund,     prior.housingFund),
      specialDeduction:mk(rec.specialDeduction,prior.specialDeduction),
      taxCurrent:      mk(rec.taxCurrent,      prior.taxCurrent),
      netPay:          mk(rec.netPay,          prior.netPay),
    };

    const maxAbsDelta = Math.max(...Object.values(fields).map((f) => Math.abs(f.delta)));
    const changed = maxAbsDelta > 0;

    const flags: string[] = [];
    if (rec.taxConfigVersion !== prior.taxConfigVersion) {
      flags.push("tax_config_changed");
    }

    rows.push({
      employeeName: rec.employeeName,
      fields,
      maxAbsDelta,
      changed,
      flags,
    });
  }

  // 排序：new 优先（flags 含 "new"），其余按 maxAbsDelta 降序
  rows.sort((a, b) => {
    const aNew = a.flags.includes("new") ? 1 : 0;
    const bNew = b.flags.includes("new") ? 1 : 0;
    if (aNew !== bNew) return bNew - aNew; // new 在前
    return b.maxAbsDelta - a.maxAbsDelta;
  });

  // dropped：priorRoster 有但 current 无
  const dropped = priorRoster.filter((name) => !currentNames.has(name));

  return { rows, newEmployees, dropped, comparedFromPeriod };
}
