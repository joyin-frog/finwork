import type { DatabaseSync } from "node:sqlite";
import { getDb, setAppSetting } from "./sqlite";
import type { CashObligation } from "../domain/cash-obligations";
import { type CumulativePayrollResult, type TaxConfig } from "@/lib/domain/tax-cumulative";
import { DEFAULT_TAX_RATES, type TaxRates } from "@/lib/domain/tax-config";
import { queryPolicyRule } from "./rule-store";
import { recordAudit } from "./audit-store";

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
  options?: { overwriteConfirmed?: boolean; db?: DatabaseSync; receiptId?: number }
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
    recordAudit(db, {
      eventType: "payroll_confirmed_overwrite",
      payload: {
        employeeName: result.employeeName,
        year,
        month,
        previousStatus: "confirmed",
      },
      // undo=null: 周期确认是业务动作，撤销走业务流程
    });
  }

  const ctx = `fact_payroll(${result.employeeName},${year},${month})`;
  const receiptId = options?.receiptId ?? null;
  // SQL 层守卫：仅在非显式覆盖时（overwriteConfirmed 未设置）加 WHERE 条件，
  // 防止并发进程在快照 SELECT 之后、UPSERT 之前悄悄确认导致的降级（多进程防写）。
  // 显式 overwriteConfirmed=true 时单进程行为保持不变，不加守卫。
  const conflictGuard = options?.overwriteConfirmed ? "" : "\n    WHERE settlement_status != 'confirmed'";
  db.prepare(
    `INSERT INTO fact_payroll (
      employee_name, year, month,
      gross_pay_cents, social_insurance_cents, housing_fund_cents, special_deduction_cents, months_employed,
      gross_cum_cents, social_cum_cents, fund_cum_cents, special_cum_cents,
      taxable_income_cum_cents, tax_due_cum_cents, tax_current_cents, tax_withheld_cum_cents, net_pay_cents,
      caliber_version, detail_json, settlement_status, confirmed_at, receipt_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?)
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
      confirmed_at = NULL,
      receipt_id = excluded.receipt_id${conflictGuard}`
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
    JSON.stringify(result.detail),
    receiptId
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
    // 用 UPDATE 实际 changes 行数对应的员工集合，不再用事务前快照——
    // 0 行更新时审计不得声称确认了 N 人（并发防审计虚报）。
    const actuallyConfirmed: string[] = [];
    for (const draft of drafts) {
      const result = update.run(draft.employeeName, year, month);
      if (result.changes > 0) {
        actuallyConfirmed.push(draft.employeeName);
      }
    }
    recordAudit(db, {
      eventType: "payroll_confirm",
      payload: { year, month, employees: actuallyConfirmed },
      // undo=null: 周期确认是业务动作，撤销走业务流程（event_type 逐字不变——哨兵 payroll-card.test.ts:72-75）
    });
    db.exec("COMMIT");
    return { confirmed: actuallyConfirmed, alreadyConfirmed };
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
  /** 税率（REAL，如 0.09），由写入方 parseFloat 后传入；NULL 表示未知 */
  taxRate?: number | null;
  /** 税额分（调用方已完成元→分转换），NULL 表示未知 */
  taxAmountCents?: number | null;
  /** 对手方（供应商/客户名称），NULL 表示未知 */
  counterparty?: string | null;
  /** 发票方向：'in'=进项 | 'out'=销项；NULL 表示历史记录未标注 */
  direction?: string | null;
  /** 认证状态，NULL 表示未认证/未知（本期工具不暴露此字段） */
  certificationStatus?: string | null;
};

export type RecordInvoicesResult = {
  inserted: string[];
  /** 已在台账中的发票:重复报销信号,必须显式呈现 */
  duplicates: Array<{ invoiceNo: string; recordedAt: string }>;
};

/** recordInvoices 的可选审计归因参数（供 sales-invoices 覆盖默认报销值）。
 * 缺省时保持 eventType:'invoice_ledger_record' + toolName:'record_reimbursement_invoices'，
 * 确保报销路径与既有测试（AU11）的行为不变。
 */
export type RecordInvoicesAuditHint = {
  eventType: string;
  toolName: string;
};

export function recordInvoices(
  items: InvoiceLedgerEntry[],
  db: DatabaseSync = getDb(),
  auditHint?: RecordInvoicesAuditHint
): RecordInvoicesResult {
  // 查重 SELECT 留事务外（已知 TOCTOU 局限，本批不处理）
  const existing = findInvoicesInLedger(items.map((i) => i.invoiceNo), db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO fact_invoices
       (invoice_no, amount_cents, invoice_date, category, conversation_id, source,
        tax_rate, tax_amount_cents, counterparty, direction, certification_status)
     VALUES (?, ?, ?, ?, ?, 'user_dictated', ?, ?, ?, ?, ?)`
  );
  const inserted: string[] = [];
  const duplicates: RecordInvoicesResult["duplicates"] = [];

  // 预分类（无 DB 调用，仅查询 existing Map）
  for (const item of items) {
    const prior = existing.get(item.invoiceNo);
    if (prior) {
      duplicates.push({ invoiceNo: item.invoiceNo, recordedAt: prior.recordedAt });
    } else {
      inserted.push(item.invoiceNo);
    }
  }

  if (inserted.length > 0) {
    // conversationId 从 items 第一条取（同一批次归同一会话）
    const convId = items.find((i) => i.conversationId != null)?.conversationId ?? null;
    const insertableItems = items.filter((i) => !existing.has(i.invoiceNo));
    // INSERT 与 recordAudit 包进同一事务，保证写+审计原子性
    db.exec("BEGIN");
    try {
      for (const item of insertableItems) {
        const ctx = `fact_invoices.${item.invoiceNo}`;
        insert.run(
          item.invoiceNo,
          yuanToCents(item.amount, ctx),
          item.invoiceDate ?? null,
          item.category ?? null,
          item.conversationId ?? null,
          item.taxRate ?? null,
          item.taxAmountCents ?? null,
          item.counterparty ?? null,
          item.direction ?? null,
          item.certificationStatus ?? null,
        );
      }
      // 缺省保持报销路径原值；sales-invoices 传 auditHint 覆盖，使审计轨迹不混淆
      recordAudit(db, {
        eventType: auditHint?.eventType ?? "invoice_ledger_record",
        payload: { inserted, duplicates: duplicates.map((d) => d.invoiceNo) },
        conversationId: convId,
        toolName: auditHint?.toolName ?? "record_reimbursement_invoices",
        // undo=delete_rows 仅 inserted（被 INSERT OR IGNORE 忽略的重复行不进 inserted，不会误删）
        undo: [{ op: "delete_rows", table: "fact_invoices", keyColumn: "invoice_no", keys: inserted }],
      });
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
      throw err;
    }
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

export type InvoiceLedgerBreakdown = {
  /** 当月台账张数（按 invoice_date 归属该年月） */
  total: number;
  /** direction='in' 的进项发票张数与税额合计（分） */
  directionIn: { count: number; taxAmountCentsSum: number };
  /** 当月 certification_status IS NULL 的张数（未认证/历史未设，仅限当月口径） */
  uncertifiedCount: number;
  /** 当月 direction IS NULL 的张数（历史记录未标注方向，仅限当月口径） */
  directionUnknownCount: number;
  /** 当月 direction='in' 中 tax_amount_cents IS NULL 的张数（税额未录） */
  taxMissingCount: number;
};

/**
 * 按年月查询发票台账明细汇总（year/month 基于 invoice_date）。
 * total 与 directionIn 均按 invoice_date 归属该年月统计；
 * invoice_date 为 NULL 的发票不计入 total（filing-precheck 靠 total>0 判断"本期是否有登记"，
 * 全库口径会把历史月份的存量误判为本期已登记）。
 */
export function getInvoiceLedgerBreakdown(year: number, month: number, db: DatabaseSync = getDb()): InvoiceLedgerBreakdown {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM fact_invoices WHERE invoice_date LIKE ?").get(`${prefix}%`) as { n: number }
  ).n;

  const dirInRow = db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(tax_amount_cents), 0) AS tax_sum
     FROM fact_invoices
     WHERE direction = 'in' AND invoice_date LIKE ?`
  ).get(`${prefix}%`) as { cnt: number; tax_sum: number } | undefined;

  // WP-D #5: uncertifiedCount 与 directionUnknownCount 加与 total 相同的月份过滤
  const uncertified = (
    db.prepare("SELECT COUNT(*) AS n FROM fact_invoices WHERE certification_status IS NULL AND invoice_date LIKE ?").get(`${prefix}%`) as { n: number }
  ).n;

  const dirUnknown = (
    db.prepare("SELECT COUNT(*) AS n FROM fact_invoices WHERE direction IS NULL AND invoice_date LIKE ?").get(`${prefix}%`) as { n: number }
  ).n;

  // WP-D #6: 当月进项中税额未录张数
  const taxMissing = (
    db.prepare("SELECT COUNT(*) AS n FROM fact_invoices WHERE direction = 'in' AND tax_amount_cents IS NULL AND invoice_date LIKE ?").get(`${prefix}%`) as { n: number }
  ).n;

  return {
    total,
    directionIn: { count: dirInRow?.cnt ?? 0, taxAmountCentsSum: dirInRow?.tax_sum ?? 0 },
    uncertifiedCount: uncertified,
    directionUnknownCount: dirUnknown,
    taxMissingCount: taxMissing,
  };
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

export function upsertBusinessMetrics(
  rows: BusinessMetricRow[],
  db: DatabaseSync = getDb(),
  conversationId?: number | null
): void {
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

  // before-image SELECTs、写操作、ID 查询、recordAudit 全部在同一事务内，保证原子性
  type MetricBeforeImage = Record<string, unknown>;
  // 构建 undo 载荷：新插入行用 delete_rows，更新行用 restore_rows（before-image）
  type UndoOpLocal = { op: "delete_rows"; table: string; keyColumn: string; keys: number[] } | { op: "restore_rows"; table: string; keyColumn: string; rows: MetricBeforeImage[] };

  db.exec("BEGIN");
  try {
    const beforeImages: MetricBeforeImage[] = [];
    const newInserts: Array<{ year: number; month: number }> = [];

    // 收集 before-images（事务内 SELECT，快照一致）
    for (const row of rows) {
      const existing = db.prepare(
        "SELECT * FROM fact_metrics WHERE year = ? AND month = ?"
      ).get(row.year, row.month) as MetricBeforeImage | undefined;
      if (existing) {
        beforeImages.push(existing);
      } else {
        newInserts.push({ year: row.year, month: row.month });
      }
    }

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

    const undoOps: UndoOpLocal[] = [];
    if (beforeImages.length > 0) {
      undoOps.push({
        op: "restore_rows",
        table: "fact_metrics",
        keyColumn: "id",
        rows: beforeImages,
      });
    }
    if (newInserts.length > 0) {
      // 刚插入的行：按 (year,month) 查 id
      const ids: number[] = [];
      for (const ni of newInserts) {
        const r = db.prepare("SELECT id FROM fact_metrics WHERE year = ? AND month = ?").get(ni.year, ni.month) as { id: number } | undefined;
        if (r) ids.push(r.id);
      }
      if (ids.length > 0) {
        undoOps.push({ op: "delete_rows", table: "fact_metrics", keyColumn: "id", keys: ids });
      }
    }

    recordAudit(db, {
      eventType: "business_metrics_write",
      payload: { rows: rows.map((r) => ({ year: r.year, month: r.month })) },
      conversationId: conversationId ?? null,
      toolName: "record_business_metrics",
      undo: undoOps.length > 0 ? undoOps : undefined,
    });

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
    throw err;
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

// auditLog 私有函数已删除（WP15）：全部调用点迁移到 audit-store.recordAudit

/**
 * WP1b 读函数：从 fact_obligations 表读出 CashObligation[]（与 deriveCashObligations 逐字段等价）。
 * - kind: pay→付款 / receive→收款 / invoice→开票
 * - amount: amount_cents NULL→undefined，否则 /100（元）
 * - status: 返回 status_raw 原始中文状态（与 deriveCashObligations 输出的 status 字段等价）
 * - done: settlement_status === 'settled' 或 status_raw 以"已"开头
 * - sourceDoc: 直读 source_doc 列（不 JOIN 还原）
 */
export function listCashObligations(db: DatabaseSync = getDb()): CashObligation[] {
  type ObRow = {
    id: number;
    kind: "pay" | "receive" | "invoice";
    amount_cents: number | null;
    due_date: string;
    counterparty: string | null;
    status: string;
    status_raw: string;
    source_doc: string | null;
    recurrence: string | null;
    source_document_id: number;
  };

  const rows = db.prepare(
    `SELECT id, kind, amount_cents, due_date, counterparty, status, status_raw, source_doc,
            recurrence, source_document_id
     FROM fact_obligations
     ORDER BY due_date ASC`
  ).all() as ObRow[];

  const kindMap: Record<"pay" | "receive" | "invoice", CashObligation["kind"]> = {
    pay: "付款",
    receive: "收款",
    invoice: "开票",
  };

  return rows.map((r) => ({
    documentId: r.source_document_id,
    counterparty: r.counterparty ?? "未填对方",
    kind: kindMap[r.kind] ?? "付款",
    amount: r.amount_cents == null ? undefined : r.amount_cents / 100,
    dueDate: r.due_date,
    status: r.status_raw,
    recurrence: (r.recurrence ?? undefined) as CashObligation["recurrence"],
    sourceDoc: r.source_doc ?? undefined,
    done: r.status === "settled",
  }));
}

/**
 * WP13a 应收账龄读函数：直查 fact_obligations（kind='receive'），分值原样返回。
 *
 * - amount_cents 保持分值（NULL 不转 0）
 * - status/status_raw 双字段原样返回
 * - agingDays = daysBetween(asOf, due_date)（asOf 缺省今天，正=未到期，负=逾期）
 * - includeSettled=false（默认）时过滤 status='settled' 行
 * - 不做元→分回转（避免单位混淆风险，reviewer N1/N2 定案）
 */
export type ReceivableRawRow = {
  counterparty: string;
  amountCents: number | null;
  dueDate: string;
  agingDays: number;
  status: "pending" | "settled";
  statusRaw: string;
  sourceDoc: string | null;
};

export function listReceivablesRaw(
  db: DatabaseSync = getDb(),
  opts?: { includeSettled?: boolean; asOf?: string }
): ReceivableRawRow[] {
  const includeSettled = opts?.includeSettled ?? false;
  const asOf = opts?.asOf ?? new Date().toISOString().slice(0, 10);

  type ObRawRow = {
    amount_cents: number | null;
    due_date: string;
    counterparty: string | null;
    status: string;
    status_raw: string;
    source_doc: string | null;
  };

  const statusClause = includeSettled ? "" : "AND status = 'pending'";
  const rows = db
    .prepare(
      `SELECT amount_cents, due_date, counterparty, status, status_raw, source_doc
       FROM fact_obligations
       WHERE kind = 'receive' ${statusClause}
       ORDER BY due_date ASC`
    )
    .all() as ObRawRow[];

  // daysBetween（复用逻辑：asOf-dueDate，正=未到期，负=逾期）
  function agingDays(dueDate: string): number {
    const [ay, am, ad] = asOf.split("-").map(Number);
    const [dy, dm, dd] = dueDate.split("-").map(Number);
    const tAsOf = Date.UTC(ay, (am ?? 1) - 1, ad ?? 1);
    const tDue = Date.UTC(dy, (dm ?? 1) - 1, dd ?? 1);
    return Math.round((tDue - tAsOf) / 86_400_000);
  }

  return rows.map((r) => ({
    counterparty: r.counterparty ?? "未填对方",
    amountCents: r.amount_cents,
    dueDate: r.due_date,
    agingDays: agingDays(r.due_date),
    status: r.status as "pending" | "settled",
    statusRaw: r.status_raw,
    sourceDoc: r.source_doc,
  }));
}

// ─── WP13b: 销项回款落盘 ─────────────────────────────────────────────────────

export type SettleInvoiceInput = {
  invoiceNo: string;
  /** 实收金额（元），元→分精度守卫（|raw-rounded| < 0.005 分） */
  settledAmountYuan: number;
  /** 实收日期 YYYY-MM-DD，缺省当日 */
  settledAt?: string;
  /** 回款备注（可选） */
  note?: string;
  /** 当前会话 ID，透传至 recordAudit（N1：工具层 conversationId 不再静默丢弃） */
  conversationId?: number | null;
};

export type SettleInvoiceResult =
  | { success: true; auditId: number }
  | { success: false; notFound: true }
  | { success: false; wrongDirection: true }
  | { success: false; directionUnknown: true }
  | { success: false; alreadySettled: true; settledAt: string | null; settledAmountCents: number | null };

/**
 * 销项发票回款落盘（WP13b）。
 *
 * 执行顺序（B2 约束）：
 * 1. SELECT * 捕获全列 before-image（含三列，此时均 NULL）
 * 2. UPDATE settlement_status + 三列
 * 3. recordAudit（undo=restore_rows before-image）
 *
 * 保证撤销后三列回 NULL、status 回 'recorded'。
 */
export function settleInvoice(input: SettleInvoiceInput, db: DatabaseSync = getDb()): SettleInvoiceResult {
  const ctx = `fact_invoices.${input.invoiceNo}`;

  // 元→分精度守卫
  const amtCents = yuanToCents(input.settledAmountYuan, ctx);
  const settledAt = input.settledAt ?? new Date().toISOString().slice(0, 10);

  // 1. 查发票存在性、方向、状态
  const existing = db.prepare(
    "SELECT * FROM fact_invoices WHERE invoice_no = ?"
  ).get(input.invoiceNo) as Record<string, unknown> | undefined;

  if (!existing) {
    return { success: false, notFound: true };
  }
  // direction IS NULL 的历史发票单独标注，不得误报为进项
  if (existing.direction === null || existing.direction === undefined) {
    return { success: false, directionUnknown: true };
  }
  if (existing.direction !== "out") {
    return { success: false, wrongDirection: true };
  }
  if (existing.settlement_status === "settled") {
    return {
      success: false,
      alreadySettled: true,
      settledAt: existing.settled_at as string | null,
      settledAmountCents: existing.settled_amount_cents as number | null,
    };
  }

  // 2+3. UPDATE + recordAudit 包进同一事务，保证写+审计原子性
  // SQL 守卫：AND (settlement_status IS NULL OR settlement_status != 'settled')
  // 并发防写——若另一进程在快照 SELECT 之后已落盘 settled，本次 UPDATE 影响 0 行。
  let auditId: number;
  db.exec("BEGIN");
  try {
    const updateResult = db.prepare(`
      UPDATE fact_invoices
      SET settlement_status    = 'settled',
          settled_at           = ?,
          settled_amount_cents = ?,
          settlement_note      = ?
      WHERE invoice_no = ?
        AND (settlement_status IS NULL OR settlement_status != 'settled')
    `).run(settledAt, amtCents, input.note ?? null, input.invoiceNo);

    if (updateResult.changes === 0) {
      // 守卫命中：另一进程已结算。先 ROLLBACK（不得带开放事务 return），
      // 再重新 SELECT 取最新快照（事务外快照已过期）。
      db.exec("ROLLBACK");
      const fresh = db.prepare(
        "SELECT settled_at, settled_amount_cents FROM fact_invoices WHERE invoice_no = ?"
      ).get(input.invoiceNo) as Record<string, unknown> | undefined;
      return {
        success: false,
        alreadySettled: true,
        settledAt: (fresh?.settled_at ?? null) as string | null,
        settledAmountCents: (fresh?.settled_amount_cents ?? null) as number | null,
      };
    }

    auditId = recordAudit(db, {
      eventType: "invoice_settlement",
      payload: { invoiceNo: input.invoiceNo, settledAmountYuan: input.settledAmountYuan, settledAt },
      conversationId: input.conversationId ?? null,
      toolName: "record_invoice_settlement",
      undo: [{ op: "restore_rows", table: "fact_invoices", keyColumn: "invoice_no", rows: [existing] }],
    });
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
    throw err;
  }

  return { success: true, auditId };
}

// ─── WP13b: 销项清单（发票层账龄）────────────────────────────────────────────

export type SalesInvoiceRow = {
  invoiceNo: string;
  amountCents: number;
  invoiceDate: string | null;
  category: string | null;
  counterparty: string | null;
  settlementStatus: string;
  settledAt: string | null;
  settledAmountCents: number | null;
  settlementNote: string | null;
  recordedAt: string;
  /**
   * 已开票天数（asOf − invoice_date，正值）。
   * - 仅未 settled 行计算；settled 行为 null。
   * - invoice_date NULL 时为 null（显式标注无法计算）。
   * B1 符号约定：与合同层 agingDays（due_date − asOf，正=未到期）刻意相反；
   * 不得共享分箱逻辑。
   */
  agingDays: number | null;
};

/**
 * 销项发票清单（WP13b）。
 *
 * - direction='out' 全列
 * - agingDays = asOf − invoice_date（正值=已开票 N 天）；仅未 settled 行计算
 * - invoice_date NULL 时 agingDays=null
 * - includeSettled=false（默认）时过滤 settled 行
 */
export function listSalesInvoices(
  opts?: { asOf?: string; includeSettled?: boolean },
  db: DatabaseSync = getDb()
): SalesInvoiceRow[] {
  const asOf = opts?.asOf ?? new Date().toISOString().slice(0, 10);
  const includeSettled = opts?.includeSettled ?? false;

  const statusClause = includeSettled ? "" : "AND settlement_status != 'settled'";

  type RawRow = {
    invoice_no: string;
    amount_cents: number;
    invoice_date: string | null;
    category: string | null;
    counterparty: string | null;
    settlement_status: string;
    settled_at: string | null;
    settled_amount_cents: number | null;
    settlement_note: string | null;
    recorded_at: string;
  };

  const rows = db.prepare(
    `SELECT invoice_no, amount_cents, invoice_date, category, counterparty,
            settlement_status, settled_at, settled_amount_cents, settlement_note, recorded_at
     FROM fact_invoices
     WHERE direction = 'out' ${statusClause}
     ORDER BY recorded_at DESC`
  ).all() as RawRow[];

  // agingDays = asOf − invoice_date（正值，已开票天数）
  // B1 符号约定：销项层正值=已开票天数；与合同层（due_date − asOf，正=未到期）方向相反
  function computeAgingDays(invoiceDate: string): number {
    const [ay, am, ad] = asOf.split("-").map(Number);
    const [iy, im, iday] = invoiceDate.split("-").map(Number);
    const tAsOf = Date.UTC(ay, (am ?? 1) - 1, ad ?? 1);
    const tInv = Date.UTC(iy, (im ?? 1) - 1, iday ?? 1);
    return Math.round((tAsOf - tInv) / 86_400_000);
  }

  return rows.map((r) => ({
    invoiceNo: r.invoice_no,
    amountCents: r.amount_cents,
    invoiceDate: r.invoice_date,
    category: r.category,
    counterparty: r.counterparty,
    settlementStatus: r.settlement_status,
    settledAt: r.settled_at,
    settledAmountCents: r.settled_amount_cents,
    settlementNote: r.settlement_note,
    recordedAt: r.recorded_at,
    // settled 行不计算账龄（已收款，账龄无业务意义）；NULL date 也无法计算
    agingDays: (r.settlement_status === "settled" || r.invoice_date == null)
      ? null
      : computeAgingDays(r.invoice_date),
  }));
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
