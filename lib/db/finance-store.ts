import type { DatabaseSync } from "node:sqlite";
import { getDb, setAppSetting } from "./sqlite";
import { DEFAULT_TAX_CONFIG, type CumulativePayrollResult, type TaxConfig } from "@/lib/domain/tax-cumulative";
import { DEFAULT_TAX_RATES, type TaxRates } from "@/lib/domain/tax-config";

/**
 * 税率配置:优先读 app_settings 的 tax_config(政策调整时无需改代码),否则用内置默认。
 * 配置损坏时显式报错,不静默回落——错的税率比报错更糟。
 */
export function loadTaxConfig(db: DatabaseSync = getDb()): TaxConfig {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'tax_config'").get() as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_TAX_CONFIG;
  let parsed: TaxConfig;
  try {
    parsed = JSON.parse(row.value) as TaxConfig;
  } catch {
    throw new Error("app_settings 中的 tax_config 不是合法 JSON,请修复或删除该配置后重试");
  }
  if (!parsed.version || !Array.isArray(parsed.brackets) || parsed.brackets.length === 0 || !(parsed.basicDeductionMonthly > 0)) {
    throw new Error("app_settings 中的 tax_config 缺少 version/brackets/basicDeductionMonthly,请修复或删除该配置后重试");
  }
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

/** 增值税/企业所得税法定税率集:优先 app_settings 的 tax_rates(政策变更不必改代码),否则内置默认。 */
export function loadTaxRates(db: DatabaseSync = getDb()): TaxRates {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'tax_rates'").get() as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_TAX_RATES;
  try {
    const parsed = JSON.parse(row.value) as Partial<TaxRates>;
    const ok = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.length > 0 && xs.every((r) => typeof r === "string");
    return {
      vat: ok(parsed.vat) ? parsed.vat : DEFAULT_TAX_RATES.vat,
      cit: ok(parsed.cit) ? parsed.cit : DEFAULT_TAX_RATES.cit,
    };
  } catch {
    return DEFAULT_TAX_RATES;
  }
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
export function savePayrollDraft(
  year: number,
  month: number,
  result: CumulativePayrollResult,
  monthsEmployed: number,
  options?: { overwriteConfirmed?: boolean; db?: DatabaseSync }
): void {
  const db = options?.db ?? getDb();
  const existing = db
    .prepare("SELECT status FROM payroll_records WHERE employee_name = ? AND year = ? AND month = ?")
    .get(result.employeeName, year, month) as { status: PayrollRecordStatus } | undefined;

  if (existing?.status === "confirmed") {
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

  db.prepare(
    `INSERT INTO payroll_records (
      employee_name, year, month,
      gross_pay, social_insurance, housing_fund, special_deduction, months_employed,
      gross_cum, social_cum, fund_cum, special_cum,
      taxable_income_cum, tax_due_cum, tax_current, tax_withheld_cum, net_pay,
      tax_config_version, detail_json, status, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL)
    ON CONFLICT(employee_name, year, month) DO UPDATE SET
      gross_pay = excluded.gross_pay,
      social_insurance = excluded.social_insurance,
      housing_fund = excluded.housing_fund,
      special_deduction = excluded.special_deduction,
      months_employed = excluded.months_employed,
      gross_cum = excluded.gross_cum,
      social_cum = excluded.social_cum,
      fund_cum = excluded.fund_cum,
      special_cum = excluded.special_cum,
      taxable_income_cum = excluded.taxable_income_cum,
      tax_due_cum = excluded.tax_due_cum,
      tax_current = excluded.tax_current,
      tax_withheld_cum = excluded.tax_withheld_cum,
      net_pay = excluded.net_pay,
      tax_config_version = excluded.tax_config_version,
      detail_json = excluded.detail_json,
      status = 'draft',
      confirmed_at = NULL`
  ).run(
    result.employeeName,
    year,
    month,
    result.grossPay,
    result.socialInsurance,
    result.housingFund,
    result.specialDeduction,
    monthsEmployed,
    result.detail.grossCum,
    result.detail.socialCum,
    result.detail.fundCum,
    result.detail.specialCum,
    result.detail.taxableIncomeCum,
    result.detail.taxDueCum,
    result.taxCurrent,
    result.taxWithheldCum,
    result.netPay,
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
      `SELECT * FROM payroll_records
       WHERE employee_name = ? AND year = ? AND month < ? AND status = 'confirmed'
       ORDER BY month DESC LIMIT 1`
    )
    .get(employeeName, year, beforeMonth) as Record<string, unknown> | undefined;
  return row ? mapPayrollRow(row) : null;
}

export function listPayrollRecords(year: number, month: number, db: DatabaseSync = getDb()): StoredPayrollRecord[] {
  const rows = db
    .prepare("SELECT * FROM payroll_records WHERE year = ? AND month = ? ORDER BY employee_name")
    .all(year, month) as Array<Record<string, unknown>>;
  return rows.map(mapPayrollRow);
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
    "UPDATE payroll_records SET status = 'confirmed', confirmed_at = datetime('now') WHERE employee_name = ? AND year = ? AND month = ? AND status = 'draft'"
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
    "INSERT OR IGNORE INTO invoice_ledger (invoice_no, amount, invoice_date, category, conversation_id) VALUES (?, ?, ?, ?, ?)"
  );
  const inserted: string[] = [];
  const duplicates: RecordInvoicesResult["duplicates"] = [];
  for (const item of items) {
    const prior = existing.get(item.invoiceNo);
    if (prior) {
      duplicates.push({ invoiceNo: item.invoiceNo, recordedAt: prior.recordedAt });
      continue;
    }
    insert.run(item.invoiceNo, item.amount, item.invoiceDate ?? null, item.category ?? null, item.conversationId ?? null);
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
    .prepare(`SELECT invoice_no, amount, recorded_at FROM invoice_ledger WHERE invoice_no IN (${placeholders})`)
    .all(...unique) as Array<{ invoice_no: string; amount: number; recorded_at: string }>;
  for (const row of rows) {
    result.set(row.invoice_no, { recordedAt: row.recorded_at, amount: row.amount });
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
      `SELECT year, month, COUNT(*) AS count FROM payroll_records
       WHERE status = 'confirmed'
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
  const total = (db.prepare("SELECT COUNT(*) AS n FROM invoice_ledger").get() as { n: number }).n;
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const added = (
    db.prepare("SELECT COUNT(*) AS n FROM invoice_ledger WHERE recorded_at LIKE ?").get(`${prefix}%`) as { n: number }
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

export function upsertBusinessMetrics(rows: BusinessMetricRow[], db: DatabaseSync = getDb()): void {
  const stmt = db.prepare(`
    INSERT INTO business_metrics (year, month, revenue, cost, expense, profit, note, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(year, month) DO UPDATE SET
      revenue    = excluded.revenue,
      cost       = excluded.cost,
      expense    = excluded.expense,
      profit     = excluded.profit,
      note       = excluded.note,
      source     = excluded.source,
      updated_at = datetime('now')
  `);
  for (const row of rows) {
    stmt.run(
      row.year,
      row.month,
      row.revenue,
      row.cost ?? null,
      row.expense ?? null,
      row.profit,
      row.note ?? null,
      row.source ?? "user_dictated"
    );
  }
}

type MetricDbRow = {
  year: number;
  month: number;
  revenue: number;
  profit: number;
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
    "SELECT source FROM business_metrics ORDER BY year DESC, month DESC LIMIT 1"
  ).get() as { source: string } | undefined;

  return { month: monthView, quarter: quarterView, year: yearView, source: latestSource?.source ?? null };
}

function buildMonthView(year: number, month: number, db: DatabaseSync): BusinessPeriodView {
  const cur = db.prepare(
    "SELECT revenue, profit FROM business_metrics WHERE year = ? AND month = ?"
  ).get(year, month) as { revenue: number; profit: number } | undefined;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prev = db.prepare(
    "SELECT revenue, profit FROM business_metrics WHERE year = ? AND month = ?"
  ).get(prevYear, prevMonth) as { revenue: number; profit: number } | undefined;

  return {
    label: `${year}年${month}月`,
    revenue: cur?.revenue ?? null,
    profit: cur?.profit ?? null,
    prevRevenue: prev?.revenue ?? null,
    prevProfit: prev?.profit ?? null,
    monthsCovered: cur ? 1 : 0,
  };
}

function buildRangeView(
  label: string,
  curYear: number, curStart: number, curEnd: number,
  prevYear: number, prevStart: number, prevEnd: number,
  db: DatabaseSync
): BusinessPeriodView {
  const curRows = db.prepare(
    "SELECT year, month, revenue, profit FROM business_metrics WHERE year = ? AND month BETWEEN ? AND ?"
  ).all(curYear, curStart, curEnd) as MetricDbRow[];

  const prevRows = db.prepare(
    "SELECT year, month, revenue, profit FROM business_metrics WHERE year = ? AND month BETWEEN ? AND ?"
  ).all(prevYear, prevStart, prevEnd) as MetricDbRow[];

  const sumRevenue = (rows: MetricDbRow[]) =>
    rows.length ? rows.reduce((s, r) => s + r.revenue, 0) : null;
  const sumProfit = (rows: MetricDbRow[]) =>
    rows.length ? rows.reduce((s, r) => s + r.profit, 0) : null;

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
  return {
    id: Number(row.id),
    employeeName: String(row.employee_name),
    year: Number(row.year),
    month: Number(row.month),
    grossPay: Number(row.gross_pay),
    socialInsurance: Number(row.social_insurance),
    housingFund: Number(row.housing_fund),
    specialDeduction: Number(row.special_deduction),
    monthsEmployed: Number(row.months_employed),
    grossCum: Number(row.gross_cum),
    socialCum: Number(row.social_cum),
    fundCum: Number(row.fund_cum),
    specialCum: Number(row.special_cum),
    taxableIncomeCum: Number(row.taxable_income_cum),
    taxDueCum: Number(row.tax_due_cum),
    taxCurrent: Number(row.tax_current),
    taxWithheldCum: Number(row.tax_withheld_cum),
    netPay: Number(row.net_pay),
    taxConfigVersion: String(row.tax_config_version),
    status: row.status as PayrollRecordStatus,
    createdAt: String(row.created_at),
    confirmedAt: row.confirmed_at == null ? null : String(row.confirmed_at)
  };
}
