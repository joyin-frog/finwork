import { detectDataIssues, type DataRow } from "@/lib/domain/data-quality";
import { mergeLabeledTables, type MergeSource } from "@/lib/domain/table-merge";
import { checkWorkbookTies, type TieCheck } from "@/lib/domain/workbook-ties";

/** Compatibility adapters: legacy tool names execute deterministic rule-capability contracts. */
export function evaluateWorkbookTieCapability(values: Record<string, string | number | boolean | null | undefined>, checks: TieCheck[]) {
  return { capabilityId: "finance.workbook.tie-check", ruleEngine: "business-rules@1", results: checkWorkbookTies(values, checks) };
}

export function evaluateDataQualityCapability(rows: DataRow[], options: { keyFields?: string[]; requiredFields?: string[]; numericFields?: string[]; nonNegativeFields?: string[] }) {
  return { capabilityId: "finance.data-quality.detect", ruleEngine: "business-rules@1", issues: detectDataIssues(rows, options) };
}

export function evaluateTableMergeCapability(sources: MergeSource[]) {
  return { capabilityId: "finance.tables.merge-labeled", ruleEngine: "business-rules@1", merged: mergeLabeledTables(sources) };
}
