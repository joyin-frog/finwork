import type { DatabaseSync } from "node:sqlite";
import { getDb, setAppSetting } from "./sqlite";
import { type CumulativePayrollResult, type TaxConfig } from "@/lib/domain/tax-cumulative";
import { DEFAULT_TAX_RATES, type TaxRates } from "@/lib/domain/tax-config";
import { queryPolicyRule } from "./rule-store";

/**
 * 按计算期间 as-of 查询生效的个税规则（WP5a）。
 *
 * - asOf: 日期字符串 YYYY-MM-DD；无参默认今天（适合实时计算）
 * - 查无规则时显式抛错（绝不静默回退到可能过期的常量——DEFAULT 只作为 v8 种子）
 * - 补算历史期间用历史版本：传入 `${year}-${month}-01` 日期
 */
export function loadTaxConfig(db: DatabaseSync = getDb(), asOf?: string): TaxConfig {
  const effectiveDate = asOf ?? new Date().toISOString().slice(0, 10);
  const row = queryPolicyRule(db, "iit_cumulative", effectiveDate);
  if (!row) {
    throw new Error(
      `无当期个税规则（asOf=${effectiveDate}）：policy_rule_sets 中没有覆盖该日期的 iit_cumulative 规则。` +
        `请录入对应期间的个税参数后重试，或确认数据库是否已跑 v8 迁移。`
    );
  }
  let parsed: TaxConfig;
  try {
    parsed = JSON.parse(row.payload) as TaxConfig;
  } catch {
    throw new Error(
      `policy_rule_sets 中 iit_cumulative 版本 "${row.version}" 的 payload 不是合法 JSON，请检查数据完整性`
    );
  }
  if (!parsed.version || !Array.isArray(parsed.brackets) || parsed.brackets.length === 0 || !(parsed.basicDeductionMonthly > 0)) {
    throw new Error(
      `policy_rule_sets 中 iit_cumulative 版本 "${row.version}" 的 payload 缺少 version/brackets/basicDeductionMonthly`
    );
  }
  // 恢复 Infinity（JSON 序列化时 Infinity → 最大浮点数）
  parsed.brackets = parsed.brackets.map((b) => ({
    ...b,
    limit: b.limit >= 1e308 ? Number.POSITIVE_INFINITY : b.limit,
  }));
  return parsed;
}

/** 报销单笔上限:优先读 app_settings 的 reimbursement_single_limit(各公司不同),否则默认 1500。 */
export const DEFAULT_REIMBURSEMENT_SINGLE_LIMIT = 1500;
export function loadReimbursementSingleLimit(db: DatabaseSync = getDb()): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'reimbursement_single_limit'").get() as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_REIMBURSEMENT_SINGLE_LIMIT;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REIMBURSEMENT_SINGLE_LIMIT;
}

/**
 * 按计算期间 as-of 查询生效的 VAT/CIT 合法税率集（WP5a）。
 *
 * - asOf: 日期字符串 YYYY-MM-DD；无参默认今天
 * - 查无规则时显式抛错（与 loadTaxConfig 对称）
 * - 若 payload 缺少 vat/cit 字段，回落内置默认（VAT/CIT 本身不做区间历史，通常一个版本够）
 */
export function loadTaxRates(db: DatabaseSync = getDb(), asOf?: string): TaxRates {
  const effectiveDate = asOf ?? new Date().toISOString().slice(0, 10);
  const row = queryPolicyRule(db, "vat_rates", effectiveDate);
  if (!row) {
    throw new Error(
      `无当期 VAT/CIT 税率集（asOf=${effectiveDate}）：policy_rule_sets 中没有覆盖该日期的 vat_rates 规则。` +
        `请确认数据库是否已跑 v8 迁移。`
    );
  }
  let parsed: Partial<TaxRates>;
  try {
    parsed = JSON.parse(row.payload) as Partial<TaxRates>;
  } catch {
    throw new Error(
      `vat_rates 规则 payload 损坏，请检查数据完整性（版本 "${row.version}"，payload 不是合法 JSON）`
    );
  }
  const ok = (xs: unknown): xs is string[] =>
    Array.isArray(xs) && xs.length > 0 && xs.every((r) => typeof r === "string");
  if (!ok(parsed.vat) && !ok(parsed.cit)) {
    throw new Error(
      `vat_rates 规则 payload 损坏，请检查数据完整性（版本 "${row.version}"，vat/cit 字段缺失或无效）`
    );
  }
  return {
    vat: ok(parsed.vat) ? parsed.vat : DEFAULT_TAX_RATES.vat,
    cit: ok(parsed.cit) ? parsed.cit : DEFAULT_TAX_RATES.cit,
  };
}

// ─────────── 金蝶科目表(各公司不同 → 数据驱动,不写死) ───────────

// dimension = 核算维度类型(部门/供应商/客户/员工/银行账号…),科目自带属性,
// 确定科目即确定该科目需挂哪类维度;维度的"值"(哪个部门)由单据/对照表提供。
export type KingdeeAccount = { code: string; name: string; type: string; balance?: number; dimension?: string };

/**
 * 示例科目表:**仅 demo 兜底**。真实公司应用 import_kingdee_accounts 导入自家科目表,
 * 否则凭证草稿用的是假科目码、导不进他们的金蝶,且校验会拒掉他们的真实科目。
 */
export const EXAMPLE_CHART_OF_ACCOUNTS: KingdeeAccount[] = [
  { code: "1001", name: "库存现金", type: "资产", balance: 50000 },
  { code: "1002", name: "银行存款", type: "资产", balance: 1500000 },
  { code: "1122", name: "应收账款", type: "资产", balance: 350000 },
  { code: "1221", name: "其他应收款", type: "资产", balance: 18000 },
  { code: "2202", name: "应付账款", type: "负债", balance: 120000 },
  { code: "2221", name: "应交税费", type: "负债", balance: 85000 },
  { code: "2221.01", name: "应交税费-应交增值税", type: "负债", balance: 45000 },
  { code: "2241", name: "其他应付款", type: "负债", balance: 25000 },
  { code: "5001", name: "主营业务收入", type: "收入", balance: 0 },
  { code: "6601", name: "销售费用", type: "费用", balance: 0 },
  { code: "6602", name: "管理费用", type: "费用", balance: 0 },
  { code: "6602.01", name: "管理费用-差旅费", type: "费用", balance: 0 },
  { code: "6602.02", name: "管理费用-办公费", type: "费用", balance: 0 },
  { code: "6602.03", name: "管理费用-招待费", type: "费用", balance: 0 },
  { code: "6603", name: "财务费用", type: "费用", balance: 0 },
];

/**
 * 读公司科目表:优先 app_settings 的 kingdee_chart_of_accounts;没有或损坏 → 回落示例并标 isExample。
 * (科目表是参考数据非财务数值,损坏回落 + 显式标注比报错体验好;调用方据 isExample 提示用户导入。)
 */
export function loadChartOfAccounts(db: DatabaseSync = getDb()): { accounts: KingdeeAccount[]; isExample: boolean } {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'kingdee_chart_of_accounts'").get() as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (
        Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every((a) => a && typeof (a as KingdeeAccount).code === "string" && typeof (a as KingdeeAccount).name === "string")
      ) {
        return { accounts: parsed as KingdeeAccount[], isExample: false };
      }
    } catch {
      /* 损坏 → 回落示例(下面统一处理) */
    }
  }
  return { accounts: EXAMPLE_CHART_OF_ACCOUNTS, isExample: true };
}

/** 导入/覆盖公司科目表(清洗:去空 code/name、去重、补默认类别),返回入库条数。 */
export function saveChartOfAccounts(accounts: KingdeeAccount[]): number {
  const seen = new Set<string>();
  const clean: KingdeeAccount[] = [];
  for (const a of accounts ?? []) {
    const code = String(a?.code ?? "").trim();
    const name = String(a?.name ?? "").trim();
    if (!code || !name || seen.has(code)) continue;
    seen.add(code);
    const balance = typeof a.balance === "number" && Number.isFinite(a.balance) ? a.balance : undefined;
    const dimension = typeof a.dimension === "string" && a.dimension.trim() ? a.dimension.trim() : undefined;
    clean.push({
      code,
      name,
      type: String(a.type ?? "").trim() || "未分类",
      ...(balance != null ? { balance } : {}),
      ...(dimension ? { dimension } : {}),
    });
  }
  setAppSetting("kingdee_chart_of_accounts", JSON.stringify(clean));
  return clean.length;
}

export type PayrollRecordStatus = "draft" | "confirmed";

export type StoredPayrollRecord = {
  id: number;
  employeeName: string;
  year: number;
  month: number;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  monthsEmployed: number;
  grossCum: number;
  socialCum: number;
  fundCum: number;
  specialCum: number;
  taxableIncomeCum: number;
  taxDueCum: number;
  taxCurrent: number;
  taxWithheldCum: number;
  netPay: number;
  taxConfigVersion: string;
  status: PayrollRecordStatus;
  createdAt: string;
  confirmedAt: string | null;
};

/**
 * 写入/覆盖某员工某期间的工资草稿。
 * confirmed 记录默认拒绝覆盖;只有显式 overwriteConfirmed(并留审计)才允许重算。
 */
// ── 元↔分转换工具（内部使用；门面出口一律返回元）────────────────────────────
/** 元 → 分（写入时），含精度校验；超差抛错而非静默吞 */
function yuanToCents(yuan: number, ctx: string): number {
  const raw = yuan * 100;
  const rounded = Math.round(raw);
  if (Math.abs(raw - rounded) >= 0.005) {
    throw new Error(
      `精度超差: ${ctx} 金额 ${yuan} 元，|${raw} - ${rounded}| = ${Math.abs(raw - rounded).toFixed(6)} >= 0.005 分`
    );
  }
  return rounded;
}

/** 分 → 元（读取时），门面出口恢复元单位 */
function centsToYuan(cents: number): number {
  return cents / 100;
}

export function savePayrollDraft(
  year: number,
  month: number,
  result: CumulativePayrollResult,
  monthsEmployed: number,
  options?: { overwriteConfirmed?: boolean; db?: DatabaseSync }
): void {
  const db = options?.db ?? getDb();
  const existing = db
    .prepare("SELECT settlement_status FROM fact_payroll WHERE employee_name = ? AND year = ? AND month = ?")
    .get(result.employeeName, year, month) as { settlement_status: PayrollRecordStatus } | undefined;

  if (existing?.settlement_status === "confirmed") {
    if (!options?.overwriteConfirmed) {
      throw new Error(
        `${result.employeeName} ${year}年${month}月工资已确认生效,拒绝静默覆盖;如确需重算,请明确告知要重算已确认月份`
      );
    }
    auditLog(db, "payroll_confirmed_overwrite", {
      employeeName: result.employeeName,
      year,
      month,
      previousStatus: "confirmed"
    });
  }

  const ctx = `fact_payroll(${result.employeeName},${year},${month})`;
  db.prepare(
    `INSERT INTO fact_payroll (
      employee_name, year, month,
      gross_pay_cents, social_insurance_cents, housing_fund_cents, special_deduction_cents, months_employed,
      gross_cum_cents, social_cum_cents, fund_cum_cents, special_cum_cents,
      taxable_income_cum_cents, tax_due_cum_cents, tax_current_cents, tax_withheld_cum_cents, net_pay_cents,
      caliber_version, detail_json, settlement_status, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL)
    ON CONFLICT(employee_name, year, month) DO UPDATE SET
      gross_pay_cents = excluded.gross_pay_cents,
      social_insurance_cents = excluded.social_insurance_cents,
      housing_fund_cents = excluded.housing_fund_cents,
      special_deduction_cents = excluded.special_deduction_cents,
      months_employed = excluded.months_employed,
      gross_cum_cents = excluded.gross_cum_cents,
      social_cum_cents = excluded.social_cum_cents,
      fund_cum_cents = excluded.fund_cum_cents,
      special_cum_cents = excluded.special_cum_cents,
      taxable_income_cum_cents = excluded.taxable_income_cum_cents,
      tax_due_cum_cents = excluded.tax_due_cum_cents,
      tax_current_cents = excluded.tax_current_cents,
      tax_withheld_cum_cents = excluded.tax_withheld_cum_cents,
      net_pay_cents = excluded.net_pay_cents,
      caliber_version = excluded.caliber_version,
      detail_json = excluded.detail_json,
      settlement_status = 'draft',
      confirmed_at = NULL`
  ).run(
    result.employeeName,
    year,
    month,
    yuanToCents(result.grossPay, ctx),
    yuanToCents(result.socialInsurance, ctx),
    yuanToCents(result.housingFund, ctx),
    yuanToCents(result.specialDeduction, ctx),
    monthsEmployed,
    yuanToCents(result.detail.grossCum, ctx),
    yuanToCents(result.detail.socialCum, ctx),
    yuanToCents(result.detail.fundCum, ctx),
    yuanToCents(result.detail.specialCum, ctx),
    yuanToCents(result.detail.taxableIncomeCum, ctx),
    yuanToCents(result.detail.taxDueCum, ctx),
    yuanToCents(result.taxCurrent, ctx),
    yuanToCents(result.taxWithheldCum, ctx),
    yuanToCents(result.netPay, ctx),
    result.detail.taxConfigVersion,
    JSON.stringify(result.detail)
  );
}

/** 取某员工本年度 beforeMonth 之前最近一个已确认月份,作为累计接力基础 */
export function getLatestConfirmedPayroll(
  employeeName: string,
  year: number,
  beforeMonth: number,
  db: DatabaseSync = getDb()
): StoredPayrollRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM fact_payroll
       WHERE employee_name = ? AND year = ? AND month < ? AND settlement_status = 'confirmed'
       ORDER BY month DESC LIMIT 1`
    )
    .get(employeeName, year, beforeMonth) as Record<string, unknown> | undefined;
  return row ? mapPayrollRow(row) : null;
}

export function listPayrollRecords(year: number, month: number, db: DatabaseSync = getDb()): StoredPayrollRecord[] {
  const rows = db
    .prepare("SELECT * FROM fact_payroll WHERE year = ? AND month = ? ORDER BY employee_name")
    .all(year, month) as Array<Record<string, unknown>>;
  return rows.map(mapPayrollRow);
}

/**
 * 取严格早于当前期（year, month）的最近一个有 confirmed 记录的期间。
 *
 * 与既有 `getLatestConfirmedPayroll` 的区别：
 * - `getLatestConfirmedPayroll(name, year, month)` 的 SQL 是 `WHERE year=? AND month<?`（年内），
 *   1 月计薪时 `month<1` 恒空，无法跨年回溯去年 12 月——只能用于接力本年累计。
 * - 本函数跨越年份边界（`year < ? OR (year=? AND month<?)`），专供差异复核取上月花名册，
 *   不再受年内口径约束。**绝不要用 `getLatestConfirmedPayroll` 替代本函数。**
 */
export function getPriorConfirmedPeriod(
  year: number,
  month: number,
  db: DatabaseSync = getDb()
): { year: number; month: number } | null {
  // 只看「紧邻上月」（跨年：1 月的上月是去年 12 月），不回溯更早月份。
  // 否则 3 月草稿会与只有 1 月已确认的数据比对却标称「上月已确认」，产生误导的新增/漏算/差异。
  // 紧邻上月无已确认工资 → 返回 null（无基线）；diff 工具据此明说「上月无已确认基线」，不静默拿更早月充当。
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const row = db
    .prepare(
      `SELECT 1 FROM fact_payroll
       WHERE year = ? AND month = ? AND settlement_status = 'confirmed'
       LIMIT 1`
    )
    .get(prevYear, prevMonth);
  return row ? { year: prevYear, month: prevMonth } : null;
}

/**
 * 把某期间的草稿确认生效(只有 confirmed 才会作为下月累计基础),写审计日志。
 * 指定 employeeNames 时只确认这些员工;没有可确认的草稿时报错,不静默成功。
 * 幂等:范围内全部已确认时返回 alreadyConfirmed,不报错、不重写审计日志。
 */
export function confirmPayrollPeriod(
  year: number,
  month: number,
  employeeNames?: string[],
  db: DatabaseSync = getDb()
): { confirmed: string[]; alreadyConfirmed: string[] } {
  const scoped = listPayrollRecords(year, month, db).filter(
    (r) => !employeeNames?.length || employeeNames.includes(r.employeeName)
  );
  const drafts = scoped.filter((r) => r.status === "draft");
  const alreadyConfirmed = scoped.filter((r) => r.status === "confirmed").map((r) => r.employeeName);
  if (drafts.length === 0) {
    if (alreadyConfirmed.length > 0) return { confirmed: [], alreadyConfirmed };
    throw new Error(`${year}年${month}月没有待确认的工资草稿${employeeNames?.length ? `(指定员工:${employeeNames.join("、")})` : ""}`);
  }
  const update = db.prepare(
    "UPDATE fact_payroll SET settlement_status = 'confirmed', confirmed_at = datetime('now') WHERE employee_name = ? AND year = ? AND month = ? AND settlement_status = 'draft'"
  );
  db.exec("BEGIN");
  try {
    for (const draft of drafts) {
      update.run(draft.employeeName, year, month);
    }
    const confirmed = drafts.map((d) => d.employeeName);
    auditLog(db, "payroll_confirm", { year, month, employees: confirmed });
    db.exec("COMMIT");
    return { confirmed, alreadyConfirmed };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type InvoiceLedgerEntry = {
  invoiceNo: string;
  amount: number;
  invoiceDate?: string;
  category?: string;
  conversationId?: number;
};

export type RecordInvoicesResult = {
  inserted: string[];
  /** 已在台账中的发票:重复报销信号,必须显式呈现 */
  duplicates: Array<{ invoiceNo: string; recordedAt: string }>;
};

export function recordInvoices(items: InvoiceLedgerEntry[], db: DatabaseSync = getDb()): RecordInvoicesResult {
  const existing = findInvoicesInLedger(items.map((i) => i.invoiceNo), db);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO fact_invoices (invoice_no, amount_cents, invoice_date, category, conversation_id, source) VALUES (?, ?, ?, ?, ?, 'user_dictated')"
  );
  const inserted: string[] = [];
  const duplicates: RecordInvoicesResult["duplicates"] = [];
  for (const item of items) {
    const prior = existing.get(item.invoiceNo);
    if (prior) {
      duplicates.push({ invoiceNo: item.invoiceNo, recordedAt: prior.recordedAt });
      continue;
    }
    const ctx = `fact_invoices.${item.invoiceNo}`;
    insert.run(item.invoiceNo, yuanToCents(item.amount, ctx), item.invoiceDate ?? null, item.category ?? null, item.conversationId ?? null);
    inserted.push(item.invoiceNo);
  }
  if (inserted.length > 0) {
    auditLog(db, "invoice_ledger_record", { inserted, duplicates: duplicates.map((d) => d.invoiceNo) });
  }
  return { inserted, duplicates };
}

export function findInvoicesInLedger(
  invoiceNos: string[],
  db: DatabaseSync = getDb()
): Map<string, { recordedAt: string; amount: number }> {
  const result = new Map<string, { recordedAt: string; amount: number }>();
  const unique = [...new Set(invoiceNos.filter(Boolean))];
  if (unique.length === 0) return result;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT invoice_no, amount_cents, recorded_at FROM fact_invoices WHERE invoice_no IN (${placeholders})`)
    .all(...unique) as Array<{ invoice_no: string; amount_cents: number; recorded_at: string }>;
  for (const row of rows) {
    // 门面出口：分→元
    result.set(row.invoice_no, { recordedAt: row.recorded_at, amount: centsToYuan(row.amount_cents) });
  }
  return result;
}

export type PayrollPeriodSummary = {
  year: number;
  month: number;
  draftCount: number;
  confirmedCount: number;
  draftEmployees: string[];
  /** 全库最近一个有确认记录的期间 */
  latestConfirmedPeriod: { year: number; month: number; count: number } | null;
};

export function getPayrollPeriodSummary(year: number, month: number, db: DatabaseSync = getDb()): PayrollPeriodSummary {
  const records = listPayrollRecords(year, month, db);
  const drafts = records.filter((r) => r.status === "draft");
  const latest = db
    .prepare(
      `SELECT year, month, COUNT(*) AS count FROM fact_payroll
       WHERE settlement_status = 'confirmed'
       GROUP BY year, month ORDER BY year DESC, month DESC LIMIT 1`
    )
    .get() as { year: number; month: number; count: number } | undefined;
  return {
    year,
    month,
    draftCount: drafts.length,
    confirmedCount: records.length - drafts.length,
    draftEmployees: drafts.map((d) => d.employeeName),
    latestConfirmedPeriod: latest ? { year: latest.year, month: latest.month, count: latest.count } : null
  };
}

export type InvoiceLedgerStats = {
  total: number;
  addedThisMonth: number;
};

export function getInvoiceLedgerStats(year: number, month: number, db: DatabaseSync = getDb()): InvoiceLedgerStats {
  // 转换点（reviewer B3）：getInvoiceLedgerStats 的 COUNT + recorded_at LIKE 切新表 fact_invoices
  const total = (db.prepare("SELECT COUNT(*) AS n FROM fact_invoices").get() as { n: number }).n;
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const added = (
    db.prepare("SELECT COUNT(*) AS n FROM fact_invoices WHERE recorded_at LIKE ?").get(`${prefix}%`) as { n: number }
  ).n;
  return { total, addedThisMonth: added };
}

// ─── 经营数据 ────────────────────────────────────────────────────────────────

export type BusinessMetricRow = {
  year: number;
  month: number;
  revenue: number;
  cost?: number | null;
  expense?: number | null;
  profit: number;
  note?: string | null;
  source?: string;
};

export type BusinessPeriodView = {
  label: string;
  revenue: number | null;
  profit: number | null;
  prevRevenue: number | null;
  prevProfit: number | null;
  monthsCovered: number;
};

export type BusinessOverview = {
  month: BusinessPeriodView;
  quarter: BusinessPeriodView;
  year: BusinessPeriodView;
  /** 最近一条数据的来源（供 TrustBadge 推导信任级别） */
  source: string | null;
};

/**
 * 只读布尔：判断指定年月是否已有经营指标记录（WP2a R8）。
 * 查无行 → false；有行（哪怕全 0）→ true。
 */
export function hasMetricsForMonth(year: number, month: number, db: DatabaseSync = getDb()): boolean {
  const row = db.prepare("SELECT 1 FROM fact_metrics WHERE year = ? AND month = ? LIMIT 1").get(year, month);
  return row != null;
}

export function upsertBusinessMetrics(rows: BusinessMetricRow[], db: DatabaseSync = getDb()): void {
  const stmt = db.prepare(`
    INSERT INTO fact_metrics (year, month, revenue_cents, cost_cents, expense_cents, profit_cents, note, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(year, month) DO UPDATE SET
      revenue_cents  = excluded.revenue_cents,
      cost_cents     = excluded.cost_cents,
      expense_cents  = excluded.expense_cents,
      profit_cents   = excluded.profit_cents,
      note           = excluded.note,
      source         = excluded.source,
      updated_at     = datetime('now')
  `);
  for (const row of rows) {
    const ctx = `fact_metrics(${row.year},${row.month})`;
    stmt.run(
      row.year,
      row.month,
      yuanToCents(row.revenue, ctx),
      row.cost != null ? yuanToCents(row.cost, ctx) : null,
      row.expense != null ? yuanToCents(row.expense, ctx) : null,
      yuanToCents(row.profit, ctx),
      row.note ?? null,
      row.source ?? "user_dictated"
    );
  }
}

type MetricDbRow = {
  year: number;
  month: number;
  revenue_cents: number;
  profit_cents: number;
};

export function getBusinessOverview(now: Date, db: DatabaseSync = getDb()): BusinessOverview {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const quarter = Math.floor((month - 1) / 3) + 1;
  const qStart = (quarter - 1) * 3 + 1;
  const qEnd = qStart + 2;

  // Month view
  const monthView = buildMonthView(year, month, db);

  // Quarter view (current quarter vs previous quarter)
  const prevQStart = qStart - 3 > 0 ? qStart - 3 : qStart - 3 + 12;
  const prevQYear = qStart - 3 > 0 ? year : year - 1;
  const quarterView = buildRangeView(
    `${year}年Q${quarter}`,
    year, qStart, qEnd,
    prevQYear, prevQStart, prevQStart + 2,
    db
  );

  // Year view (current year vs previous year)
  const yearView = buildRangeView(
    `${year}年`,
    year, 1, month,
    year - 1, 1, month,
    db
  );

  // 取最近一条数据的 source（供 TrustBadge）
  const latestSource = db.prepare(
    "SELECT source FROM fact_metrics ORDER BY year DESC, month DESC LIMIT 1"
  ).get() as { source: string } | undefined;

  return { month: monthView, quarter: quarterView, year: yearView, source: latestSource?.source ?? null };
}

function buildMonthView(year: number, month: number, db: DatabaseSync): BusinessPeriodView {
  // 转换点（reviewer B3）：buildMonthView 读 fact_metrics，门面出口 /100 恢复元单位
  const cur = db.prepare(
    "SELECT revenue_cents, profit_cents FROM fact_metrics WHERE year = ? AND month = ?"
  ).get(year, month) as { revenue_cents: number; profit_cents: number } | undefined;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prev = db.prepare(
    "SELECT revenue_cents, profit_cents FROM fact_metrics WHERE year = ? AND month = ?"
  ).get(prevYear, prevMonth) as { revenue_cents: number; profit_cents: number } | undefined;

  return {
    label: `${year}年${month}月`,
    revenue: cur ? centsToYuan(cur.revenue_cents) : null,
    profit: cur ? centsToYuan(cur.profit_cents) : null,
    prevRevenue: prev ? centsToYuan(prev.revenue_cents) : null,
    prevProfit: prev ? centsToYuan(prev.profit_cents) : null,
    monthsCovered: cur ? 1 : 0,
  };
}

function buildRangeView(
  label: string,
  curYear: number, curStart: number, curEnd: number,
  prevYear: number, prevStart: number, prevEnd: number,
  db: DatabaseSync
): BusinessPeriodView {
  // 转换点（reviewer B3）：buildRangeView 读 fact_metrics，JS 端 reduce 聚合后 /100 恢复元单位
  const curRows = db.prepare(
    "SELECT year, month, revenue_cents, profit_cents FROM fact_metrics WHERE year = ? AND month BETWEEN ? AND ?"
  ).all(curYear, curStart, curEnd) as MetricDbRow[];

  const prevRows = db.prepare(
    "SELECT year, month, revenue_cents, profit_cents FROM fact_metrics WHERE year = ? AND month BETWEEN ? AND ?"
  ).all(prevYear, prevStart, prevEnd) as MetricDbRow[];

  // 门面出口：累计分→元（先 reduce 分单位再 /100，避免多次浮点除法误差）
  const sumRevenue = (rows: MetricDbRow[]) =>
    rows.length ? centsToYuan(rows.reduce((s, r) => s + r.revenue_cents, 0)) : null;
  const sumProfit = (rows: MetricDbRow[]) =>
    rows.length ? centsToYuan(rows.reduce((s, r) => s + r.profit_cents, 0)) : null;

  return {
    label,
    revenue: sumRevenue(curRows),
    profit: sumProfit(curRows),
    prevRevenue: sumRevenue(prevRows),
    prevProfit: sumProfit(prevRows),
    monthsCovered: curRows.length,
  };
}

function auditLog(db: DatabaseSync, eventType: string, payload: unknown) {
  db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(eventType, JSON.stringify(payload));
}

function mapPayrollRow(row: Record<string, unknown>): StoredPayrollRecord {
  // 门面出口：分→元（/100），保持 StoredPayrollRecord 类型语义为元单位
  return {
    id: Number(row.id),
    employeeName: String(row.employee_name),
    year: Number(row.year),
    month: Number(row.month),
    grossPay: centsToYuan(Number(row.gross_pay_cents)),
    socialInsurance: centsToYuan(Number(row.social_insurance_cents)),
    housingFund: centsToYuan(Number(row.housing_fund_cents)),
    specialDeduction: centsToYuan(Number(row.special_deduction_cents)),
    monthsEmployed: Number(row.months_employed),
    grossCum: centsToYuan(Number(row.gross_cum_cents)),
    socialCum: centsToYuan(Number(row.social_cum_cents)),
    fundCum: centsToYuan(Number(row.fund_cum_cents)),
    specialCum: centsToYuan(Number(row.special_cum_cents)),
    taxableIncomeCum: centsToYuan(Number(row.taxable_income_cum_cents)),
    taxDueCum: centsToYuan(Number(row.tax_due_cum_cents)),
    taxCurrent: centsToYuan(Number(row.tax_current_cents)),
    taxWithheldCum: centsToYuan(Number(row.tax_withheld_cum_cents)),
    netPay: centsToYuan(Number(row.net_pay_cents)),
    taxConfigVersion: String(row.caliber_version),  // caliber_version 承接 tax_config_version 的值域
    status: row.settlement_status as PayrollRecordStatus,  // settlement_status 承接 status
    createdAt: String(row.created_at),
    confirmedAt: row.confirmed_at == null ? null : String(row.confirmed_at)
  };
}
