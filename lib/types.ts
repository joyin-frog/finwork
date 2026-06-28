export type ReimbursementItem = {
  employeeName: string;
  expenseDate: string;
  invoiceNo: string;
  category: string;
  amount: number;
  warnings: string[];
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
