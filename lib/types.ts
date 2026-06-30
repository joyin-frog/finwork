/**
 * 功能2: 结构化规则命中——命中哪条标准 + 阈值 + 实际值。
 * 比 warnings 字符串更易机器处理（可按 rule 过滤、按 threshold/actual 排序）。
 */
export type RuleHit = {
  /** 规则标识，如 "single_limit_exceeded" / "duplicate_invoice" / "history_duplicate" / "missing_category" */
  rule: string;
  /** 人可读消息（与 warnings 对应） */
  message: string;
  /** 规则阈值（仅金额类规则，如单笔上限） */
  threshold?: number;
  /** 触发规则的实际值（仅金额类规则，如报销金额） */
  actual?: number;
};

export type ReimbursementItem = {
  employeeName: string;
  expenseDate: string;
  invoiceNo: string;
  category: string;
  amount: number;
  warnings: string[];
  /** 功能2: 结构化规则命中列表；validateReimbursements 后由 TS 层补充（Python 脚本不变） */
  ruleHits?: RuleHit[];
  /** 功能2: 可追溯计算回执；validateReimbursements 后由 TS 层补充 */
  receipt?: import("./domain/receipt").CalcReceipt;
};

export type PayrollInput = {
  employeeName: string;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
};

export type PayrollResult = PayrollInput & {
  taxableIncome: number;
  tax: number;
  netPay: number;
};

export type AnalysisItem = {
  label: string;
  amount: number;
  note: string;
};

export type ToolResult<T> = {
  ok: boolean;
  data: T;
  audit: string[];
};
