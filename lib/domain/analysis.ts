export type ExpenseRow = {
  category?: string;
  amount?: number;
};

export function summarizeExpenses(rows: ExpenseRow[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const category = row.category || "未分类";
    totals.set(category, (totals.get(category) ?? 0) + Number(row.amount ?? 0));
  }

  const byCategory = Array.from(totals.entries())
    .map(([category, amount]) => ({ category, amount: roundMoney(amount) }))
    .sort((a, b) => b.amount - a.amount);

  const total = roundMoney(byCategory.reduce((sum, item) => sum + item.amount, 0));
  const topCategory = byCategory[0]?.category ?? "无数据";

  return {
    total,
    topCategory,
    byCategory
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}
