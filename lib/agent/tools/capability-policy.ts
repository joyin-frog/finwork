import type { CapabilityManifest } from "@/lib/capability/contracts";
import { TOOL_REGISTRY } from "./registry";

export type FinanceCapabilityPolicy = {
  operation: "read" | "write";
  sideEffects: CapabilityManifest["sideEffects"];
  requiredPermissions: CapabilityManifest["requiredPermissions"];
  evidenceProduced: CapabilityManifest["evidenceProduced"];
  idempotency: CapabilityManifest["idempotency"];
};

const read = (
  target: string,
  permission = "read",
): FinanceCapabilityPolicy => ({
  operation: "read",
  sideEffects: [{ kind: "read", target, reversible: true }],
  requiredPermissions: [{ action: permission, resourceType: target, scope: "case" }],
  evidenceProduced: [{ type: "source", requiresLocator: true }],
  idempotency: { mode: "none" },
});

const compute = (target: string): FinanceCapabilityPolicy => ({
  operation: "read",
  sideEffects: [{ kind: "none", target, reversible: true }],
  requiredPermissions: [{ action: "execute", resourceType: target, scope: "case" }],
  evidenceProduced: [{ type: "transform", requiresLocator: false }],
  idempotency: { mode: "none" },
});

const write = (
  target: string,
  evidence: "transform" | "delivery" = "transform",
): FinanceCapabilityPolicy => ({
  operation: "write",
  sideEffects: [{ kind: "write", target, reversible: true }],
  requiredPermissions: [{ action: "write", resourceType: target, scope: "case" }],
  evidenceProduced: [{ type: evidence, requiresLocator: evidence === "delivery" }],
  idempotency: { mode: "none" },
});

const networkRead = (target: string): FinanceCapabilityPolicy => ({
  operation: "read",
  sideEffects: [{ kind: "network", target, reversible: true }],
  requiredPermissions: [
    { action: "read", resourceType: target, scope: "case" },
    { action: "network", resourceType: "egress", scope: "approved_destination" },
  ],
  evidenceProduced: [{ type: "source", requiresLocator: true }],
  idempotency: { mode: "none" },
});

const governedResearch = (target: string): FinanceCapabilityPolicy => ({
  operation: "write",
  sideEffects: [
    { kind: "network", target, reversible: true },
    { kind: "write", target: "research_evidence_snapshot", reversible: false },
  ],
  requiredPermissions: [
    { action: "read", resourceType: target, scope: "case" },
    { action: "network", resourceType: "egress", scope: "approved_destination" },
    { action: "write", resourceType: "research_evidence_snapshot", scope: "case" },
  ],
  evidenceProduced: [{ type: "source", requiresLocator: true }],
  idempotency: { mode: "input_hash" },
});

/**
 * Explicit policy for every neutral finance tool. This is deliberately not
 * inferred from riskLevel or the handler name: adding a tool without deciding
 * its side effects, permissions, evidence, and idempotency is a build error.
 */
export const FINANCE_CAPABILITY_POLICIES = {
  analyze_tabular: compute("tabular_data"),
  create_workbook: write("workbook"),
  spawn_subagent: compute("subagent"),
  search_knowledge: read("knowledge_index"),
  query_knowledge: read("knowledge_index"),
  read_file: read("file"),
  read_document: read("document"),
  inspect_document_structure: read("document_structure"),
  patch_document: write("document"),
  patch_workbook: write("workbook"),
  check_workbook_ties: read("workbook"),
  detect_data_issues: compute("data_quality"),
  merge_labeled_tables: compute("labeled_tables"),
  scan_slip_folder: read("folder"),
  remember_convention: write("memory_candidate"),
  remember_role_convention: write("role_memory_candidate"),
  record_business_metrics: write("business_metrics"),
  generate_business_analysis: write("workbook"),
  research_web: governedResearch("public_research_source"),
  calculate_payroll_batch: write("payroll_batch"),
  confirm_payroll_period: write("payroll_period"),
  query_payroll_status: read("payroll_period"),
  diff_payroll_period: read("payroll_period"),
  export_payslips: write("payslip_artifact", "delivery"),
  check_reimbursement_batch: read("reimbursement_batch"),
  record_reimbursement_invoices: write("reimbursement_invoice"),
  reconcile_bank_statement: compute("bank_statement"),
  read_expense_policy: read("expense_policy"),
  tax_calculator: compute("tax_calculation"),
  query_invoice_ledger: read("invoice_ledger"),
  query_receivables: read("receivable_ledger"),
  record_sales_invoices: write("sales_invoice"),
  record_invoice_settlement: write("invoice_settlement"),
  query_sales_invoices: read("sales_invoice"),
  // Reads the tenant-local imported account cache. The implementation must not
  // acquire network authority merely because the source data originally came
  // from Kingdee.
  query_kingdee_accounts: read("kingdee_account"),
  export_kingdee_draft: write("kingdee_draft", "delivery"),
  validate_kingdee_voucher: compute("kingdee_voucher"),
  import_kingdee_accounts: write("kingdee_account_cache"),
  check_voucher_amount: compute("voucher"),
  map_voucher_account: compute("voucher"),
  summarize_vouchers: compute("voucher"),
  build_voucher_lines: compute("voucher"),
  build_voucher_sheet: write("voucher_workbook"),
  process_voucher_batch: write("voucher_batch"),
  export_voucher_list: write("voucher_artifact", "delivery"),
  record_document_metadata: write("document_metadata"),
  update_company_profile: write("company_profile"),
  finalize_deliverable: write("completion_evidence", "delivery"),
  emit_checklist: write("checklist_artifact", "delivery"),
  run_filing_precheck_batch: compute("filing_precheck"),
  run_bank_recon_batch: compute("bank_reconciliation"),
  undo_last_write: write("mutation_log"),
  propose_transfer: compute("task_transfer"),
} satisfies Record<string, FinanceCapabilityPolicy>;

export type FinanceCapabilityId = keyof typeof FINANCE_CAPABILITY_POLICIES;

export function resolveFinanceCapabilityPolicy(toolId: string): FinanceCapabilityPolicy {
  const policy = (FINANCE_CAPABILITY_POLICIES as Record<string, FinanceCapabilityPolicy>)[toolId];
  if (!policy) throw new Error(`Finance tool ${toolId} has no explicit Capability policy`);
  return policy;
}

export function assertFinanceCapabilityPolicyCoverage(): void {
  const registered = TOOL_REGISTRY
    .filter((tool) => tool.category === "finance")
    .map((tool) => tool.name)
    .sort();
  assertFinanceCapabilityPolicyCatalog(registered);
}

/**
 * Runtime guard for a selected set of neutral definitions. A subagent may
 * intentionally receive only a subset, so this guard checks missing policy
 * only and does not report the remaining global policies as stale.
 */
export function assertFinanceCapabilityPoliciesFor(toolIds: Iterable<string>): void {
  const declared = new Set(Object.keys(FINANCE_CAPABILITY_POLICIES));
  const missing = [...new Set(toolIds)].sort().filter((name) => !declared.has(name));
  if (missing.length) {
    throw new Error(`Finance Capability policy drift: missing=[${missing.join(", ")}]`);
  }
}

/** Exact guard used by the registry and the complete production catalog. */
export function assertFinanceCapabilityPolicyCatalog(toolIds: Iterable<string>): void {
  const registered = [...new Set(toolIds)].sort();
  const declared = Object.keys(FINANCE_CAPABILITY_POLICIES).sort();
  const missing = registered.filter((name) => !declared.includes(name));
  const stale = declared.filter((name) => !registered.includes(name));
  if (missing.length || stale.length) {
    throw new Error(
      `Finance Capability policy drift: missing=[${missing.join(", ")}], stale=[${stale.join(", ")}]`,
    );
  }
}
