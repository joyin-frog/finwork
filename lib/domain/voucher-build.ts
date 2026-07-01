/**
 * 多行凭证构造 + 预借款冲销。
 *
 * 真实凭证是多行独立借贷(非一借一贷成对):N 个费用明细→N 个借方行(科目/维度各异),
 * 对应付款/冲销的贷方。关键开关=单据「原借款」栏:
 *   空       → 普通:借 费用(多行) / 贷 银行(合计)
 *   有金额   → 冲销:借 费用 / 贷 其他应收款-个人往来(=原借款,挂报销人) / 差额进银行
 *
 * 全程整数分,借贷恒平衡(差额行即配平项),对齐 lib/domain/money.ts。
 */
import { yuanToFen, fenToYuan } from "@/lib/domain/money";

export type ExpenseLine = {
  summary: string;
  account: string;
  accountName?: string;
  dimensionValue?: string;
  amountYuan: number;
};

export type VoucherLine = {
  summary: string;
  account: string;
  accountName?: string;
  dimensionType?: string;
  dimensionValue?: string;
  debitYuan?: number;
  creditYuan?: number;
};

export type BuildVoucherInput = {
  expenses: ExpenseLine[];
  paymentAccount: { code: string; name?: string };
  departmentName?: string; // 费用行默认维度值(报销部门)
  advanceYuan?: number; // 原借款金额;>0 走冲销
  advanceAccount?: { code: string; name?: string }; // 其他应收款-个人往来
  payeeName?: string; // 报销人(冲销行维度值=员工)
};

export type BuiltVoucher = {
  lines: VoucherLine[];
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
};

export function buildVoucherLines(input: BuildVoucherInput): BuiltVoucher {
  const { expenses, paymentAccount, departmentName, advanceYuan, advanceAccount, payeeName } = input;
  const lines: VoucherLine[] = [];

  // 借方:各费用明细行(维度=部门)
  let expenseTotalFen = 0;
  for (const e of expenses) {
    const fen = yuanToFen(e.amountYuan);
    expenseTotalFen += fen;
    lines.push({
      summary: e.summary,
      account: e.account,
      accountName: e.accountName,
      dimensionType: "部门",
      dimensionValue: e.dimensionValue ?? departmentName,
      debitYuan: fenToYuan(fen),
    });
  }

  const advanceFen = advanceYuan ? yuanToFen(advanceYuan) : 0;
  if (advanceFen > 0) {
    // 冲销:贷 其他应收款-个人往来(挂报销人),金额=原借款全额
    lines.push({
      summary: "冲销预借款",
      account: advanceAccount?.code ?? "1221.03",
      accountName: advanceAccount?.name,
      dimensionType: "员工",
      dimensionValue: payeeName,
      creditYuan: fenToYuan(advanceFen),
    });
    const diffFen = advanceFen - expenseTotalFen;
    if (diffFen > 0) {
      // 借多了 → 员工退回,借 银行/现金
      lines.push({ summary: "退回多借款", account: paymentAccount.code, accountName: paymentAccount.name, debitYuan: fenToYuan(diffFen) });
    } else if (diffFen < 0) {
      // 借少了 → 公司补付,贷 银行/现金
      lines.push({ summary: "补付款", account: paymentAccount.code, accountName: paymentAccount.name, creditYuan: fenToYuan(-diffFen) });
    }
    // diff=0:不加差额行
  } else {
    // 普通:贷 银行,金额=费用合计
    lines.push({ summary: "付款", account: paymentAccount.code, accountName: paymentAccount.name, creditYuan: fenToYuan(expenseTotalFen) });
  }

  const totalDebitFen = lines.reduce((s, l) => s + (l.debitYuan != null ? yuanToFen(l.debitYuan) : 0), 0);
  const totalCreditFen = lines.reduce((s, l) => s + (l.creditYuan != null ? yuanToFen(l.creditYuan) : 0), 0);

  return {
    lines,
    balanced: totalDebitFen === totalCreditFen,
    totalDebit: fenToYuan(totalDebitFen),
    totalCredit: fenToYuan(totalCreditFen),
  };
}
