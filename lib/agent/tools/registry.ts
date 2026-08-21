export type ToolRiskLevel = "safe" | "medium" | "high";
export type ToolCategory = "builtin" | "finance";

export type ToolDef = {
  name: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
};

export const TOOL_REGISTRY: ToolDef[] = [
  // Pi builtins are constructed and scoped in pi/builtin-tools.ts and
  // context-policy.ts. This registry is the single metadata source for the
  // production finance catalog only.
  { name: "analyze_tabular",       category: "finance", riskLevel: "safe" },
  { name: "create_workbook",       category: "finance", riskLevel: "medium" },
  { name: "spawn_subagent",        category: "finance", riskLevel: "medium" },
  { name: "search_knowledge", category: "finance", riskLevel: "safe" },
  { name: "read_document",     category: "finance", riskLevel: "safe" },
  { name: "list_workspace_files", category: "finance", riskLevel: "safe" },
  { name: "read_workspace_file", category: "finance", riskLevel: "safe" },
  { name: "patch_workspace_workbook", category: "finance", riskLevel: "medium" },
  // Task-authored code runs without network, with task-scoped reads and output-only writes.
  { name: "run_task_python", category: "finance", riskLevel: "medium" },
  { name: "inspect_document_structure", category: "finance", riskLevel: "safe" },
  { name: "patch_document", category: "finance", riskLevel: "medium" },
  // Workbook primitives: deterministic inspection/transform tools exposed by
  // the production finance catalog. Keep these in the registry so risk,
  // confirmation and renderer policy never fall back to implicit defaults.
  { name: "patch_workbook",       category: "finance", riskLevel: "medium" },
  { name: "scan_slip_folder",  category: "finance", riskLevel: "safe" },
  // 写入用户约定/角色口径:静默写入+对话内轻提示,记忆页可删(刀6 拍板去确认卡)
  { name: "remember_convention", category: "finance", riskLevel: "medium" },
  { name: "remember_role_convention", category: "finance", riskLevel: "medium" },
  // 经营数据登记
  { name: "record_business_metrics", category: "finance", riskLevel: "medium" },
  { name: "generate_business_analysis", category: "finance", riskLevel: "safe" },
  { name: "research_web", category: "finance", riskLevel: "safe" },
  // Payroll & reimbursement tools
  { name: "calculate_payroll_batch",       category: "finance", riskLevel: "high" },
  { name: "confirm_payroll_period",        category: "finance", riskLevel: "high" },
  { name: "query_payroll_status",          category: "finance", riskLevel: "safe" },
  { name: "diff_payroll_period",           category: "finance", riskLevel: "safe" },
  { name: "export_payslips",               category: "finance", riskLevel: "medium" },
  { name: "check_reimbursement_batch",     category: "finance", riskLevel: "safe" },
  { name: "record_reimbursement_invoices", category: "finance", riskLevel: "medium" },
  // Reconciliation (read-only, never touches payment)
  { name: "reconcile_bank_statement",      category: "finance", riskLevel: "safe" },
  // Policy / tax tools(文件提取走 read_document，结构化统计走 analyze_tabular)
  { name: "read_expense_policy",     category: "finance", riskLevel: "safe" },
  { name: "tax_calculator",          category: "finance", riskLevel: "safe" },
  // 发票台账只读汇总（WP1c）
  { name: "query_invoice_ledger",    category: "finance", riskLevel: "safe" },
  // 应收账龄只读清单（WP13a）
  { name: "query_receivables",       category: "finance", riskLevel: "safe" },
  // 销项发票登记 + 发票级账龄 + 回款落盘（WP13b）
  { name: "record_sales_invoices",   category: "finance", riskLevel: "medium" },
  { name: "record_invoice_settlement", category: "finance", riskLevel: "medium" },
  { name: "query_sales_invoices",    category: "finance", riskLevel: "safe" },
  // Kingdee MCP tools
  { name: "query_kingdee_accounts",    category: "finance", riskLevel: "safe" },
  { name: "export_kingdee_draft",      category: "finance", riskLevel: "high" },
  { name: "validate_kingdee_voucher",  category: "finance", riskLevel: "medium" },
  { name: "import_kingdee_accounts",   category: "finance", riskLevel: "medium" },
  // 单据勾稽、科目映射、分录构造和汇总是 process_voucher_batch 的内部步骤。
  { name: "process_voucher_batch",     category: "finance", riskLevel: "safe" },
  { name: "export_voucher_list",       category: "finance", riskLevel: "high" },
  // P1 合同归纳:结构化 metadata 起草工具
  { name: "record_document_metadata",  category: "finance", riskLevel: "medium" },
  // P3: 公司画像（税务筹划）
  { name: "update_company_profile",    category: "finance", riskLevel: "medium" },
  // 收尾声明最终产物(只写声明标记;真正清理是收尾确定性执行 + 单独审计,不挂确认门)
  { name: "finalize_deliverable",      category: "finance", riskLevel: "safe" },
  // WP14a: 物化可勾选清单工件（safe，无角色白名单，v1 主对话专用）
  { name: "emit_checklist",            category: "finance", riskLevel: "safe" },
  // 功能4首刀: 申报前复核批跑（safe，读取画像+派发；不进任何角色白名单，子代理不可递归批跑）
  { name: "run_filing_precheck_batch", category: "finance", riskLevel: "safe" },
  // 功能4第二刀: 银行对账批跑（safe，fan-out 资金专员；不进任何角色白名单，子代理不可递归批跑）
  { name: "run_bank_recon_batch",      category: "finance", riskLevel: "safe" },
  // WP15: 撤销最近 agent 写操作（high 风险，经 confirm gate 拦截；无角色白名单——主对话动作）
  { name: "undo_last_write",           category: "finance", riskLevel: "high" },
  // D2·刀8: 越权转交卡（safe；主管与专员会话均可用；不进任何角色工具白名单——角色不可递归转交）
  { name: "propose_transfer",          category: "finance", riskLevel: "safe" },
];

/** Cross-task writes that always require explicit user confirmation. */
export const ALWAYS_CONFIRM_TOOL_NAMES = new Set<string>([
  "remember_convention",
  "remember_role_convention",
  "update_company_profile",
]);

/**
 * 财务工具的免确认集合。模型实际能看到哪些工具由 context-policy.ts
 * 按当前请求裁剪；这里不再承担工具曝光职责。
 * 高风险和 always-confirm 工具必须离开该集合，确保执行时进入统一确认门。
 * Pi 基础工具由 pi/tool-names.ts 与 builtin-tools.ts 独立管理。
 */
export const ALLOWED_TOOLS: string[] = TOOL_REGISTRY
  .filter((t) => !(t.riskLevel === "high" || ALWAYS_CONFIRM_TOOL_NAMES.has(t.name)))
  .map((t) => t.name);

export function getToolRiskLevel(toolName: string): ToolRiskLevel {
  return TOOL_REGISTRY.find((t) => t.name === toolName)?.riskLevel ?? "medium";
}
