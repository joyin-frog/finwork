// 金蝶工具 structuredContent → 凭证卡片数据整形。严格校验,残缺整体回退 null。

export type VoucherEntryRow = {
  lineNumber: number;
  date: string;
  summary: string;
  debitAccount: string;
  debitAccountName: string;
  debitAmount: number;
  creditAccount: string;
  creditAccountName: string;
  creditAmount: number;
};

export type VoucherDraftCardData = {
  id: string;
  company: string;
  period: string;
  entries: VoucherEntryRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  simulated: boolean;
};

export type VoucherValidationCardData = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function parseVoucherDraftStructured(structured: unknown): VoucherDraftCardData | null {
  if (!structured || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;
  if (
    typeof s.id !== "string" || typeof s.company !== "string" || typeof s.period !== "string" ||
    !Array.isArray(s.entries) || typeof s.balanced !== "boolean" ||
    typeof s.totalDebit !== "number" || !Number.isFinite(s.totalDebit) ||
    typeof s.totalCredit !== "number" || !Number.isFinite(s.totalCredit)
  ) {
    return null;
  }

  const entries: VoucherEntryRow[] = [];
  for (const item of s.entries) {
    if (!item || typeof item !== "object") return null;
    const e = item as Record<string, unknown>;
    if (
      typeof e.lineNumber !== "number" || typeof e.date !== "string" || typeof e.summary !== "string" ||
      typeof e.debitAccount !== "string" || typeof e.creditAccount !== "string" ||
      typeof e.debitAmount !== "number" || !Number.isFinite(e.debitAmount) ||
      typeof e.creditAmount !== "number" || !Number.isFinite(e.creditAmount)
    ) {
      return null;
    }
    entries.push({
      lineNumber: e.lineNumber,
      date: e.date,
      summary: e.summary,
      debitAccount: e.debitAccount,
      debitAccountName: typeof e.debitAccountName === "string" ? e.debitAccountName : e.debitAccount,
      debitAmount: e.debitAmount,
      creditAccount: e.creditAccount,
      creditAccountName: typeof e.creditAccountName === "string" ? e.creditAccountName : e.creditAccount,
      creditAmount: e.creditAmount
    });
  }

  return {
    id: s.id,
    company: s.company,
    period: s.period,
    entries,
    totalDebit: s.totalDebit,
    totalCredit: s.totalCredit,
    balanced: s.balanced,
    simulated: s.simulated === true
  };
}

export function parseVoucherValidationStructured(structured: unknown): VoucherValidationCardData | null {
  if (!structured || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;
  if (typeof s.valid !== "boolean" || !Array.isArray(s.errors) || !Array.isArray(s.warnings)) return null;
  return {
    valid: s.valid,
    errors: s.errors.filter((e): e is string => typeof e === "string"),
    warnings: s.warnings.filter((w): w is string => typeof w === "string")
  };
}
