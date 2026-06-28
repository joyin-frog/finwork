// check_reimbursement_batch 的 structuredContent → 报销核对卡片数据整形。
// 严格校验,残缺整体回退 null;行序保留(工具已按风险排序,历史重复最优先)。

export type ReimbursementCardRow = {
  employeeName: string;
  expenseDate: string;
  invoiceNo: string;
  category: string;
  amount: number;
  warnings: string[];
};

export type ReimbursementCardData = {
  rows: ReimbursementCardRow[];
  summary: string;
  abnormalCount: number;
};

export function parseReimbursementStructured(structured: unknown): ReimbursementCardData | null {
  if (!structured || typeof structured !== "object") return null;
  const source = structured as { results?: unknown; summary?: unknown; abnormalCount?: unknown };
  if (!Array.isArray(source.results)) return null;

  const rows: ReimbursementCardRow[] = [];
  for (const item of source.results) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (
      typeof r.employeeName !== "string" || typeof r.expenseDate !== "string" ||
      typeof r.invoiceNo !== "string" || typeof r.category !== "string" ||
      typeof r.amount !== "number" || !Number.isFinite(r.amount)
    ) {
      return null;
    }
    rows.push({
      employeeName: r.employeeName,
      expenseDate: r.expenseDate,
      invoiceNo: r.invoiceNo,
      category: r.category,
      amount: r.amount,
      warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : []
    });
  }

  return {
    rows,
    summary: typeof source.summary === "string" ? source.summary : `共 ${rows.length} 条`,
    abnormalCount: typeof source.abnormalCount === "number" && Number.isFinite(source.abnormalCount)
      ? source.abnormalCount
      : rows.filter((r) => r.warnings.length > 0).length
  };
}
