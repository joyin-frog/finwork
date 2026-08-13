export type ToolRiskLevel = "safe" | "medium" | "high";
export type ToolCategory = "builtin" | "finance";

export type ToolDef = {
  name: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
};

export const TOOL_REGISTRY: ToolDef[] = [
  // Built-in SDK tools
  { name: "Read",             category: "builtin", riskLevel: "safe" },
  { name: "Glob",             category: "builtin", riskLevel: "safe" },
  { name: "Grep",             category: "builtin", riskLevel: "safe" },
  { name: "AskUserQuestion",  category: "builtin", riskLevel: "safe" },
  { name: "WebSearch",        category: "builtin", riskLevel: "safe" },
  { name: "WebFetch",         category: "builtin", riskLevel: "safe" },
  { name: "Monitor",          category: "builtin", riskLevel: "safe" },
  { name: "Write",            category: "builtin", riskLevel: "medium" },
  { name: "Edit",             category: "builtin", riskLevel: "medium" },
  { name: "MultiEdit",        category: "builtin", riskLevel: "medium" },
  { name: "Bash",             category: "builtin", riskLevel: "high" },
  // Core MCP tools
  { name: "analyze_tabular",       category: "finance", riskLevel: "safe" },
  { name: "create_workbook",       category: "finance", riskLevel: "medium" },
  { name: "spawn_subagent",        category: "finance", riskLevel: "medium" },
  { name: "search_knowledge", category: "finance", riskLevel: "safe" },
  { name: "query_knowledge",  category: "finance", riskLevel: "medium" },
  { name: "read_file",        category: "finance", riskLevel: "safe" },
  { name: "read_document",     category: "finance", riskLevel: "safe" },
  { name: "inspect_document_structure", category: "finance", riskLevel: "safe" },
  { name: "patch_document", category: "finance", riskLevel: "medium" },
  // Workbook primitives: deterministic inspection/transform tools exposed by
  // the production finance catalog. Keep these in the registry so risk,
  // confirmation and renderer policy never fall back to implicit defaults.
  { name: "patch_workbook",       category: "finance", riskLevel: "medium" },
  { name: "check_workbook_ties", category: "finance", riskLevel: "safe" },
  { name: "detect_data_issues",  category: "finance", riskLevel: "safe" },
  { name: "merge_labeled_tables", category: "finance", riskLevel: "safe" },
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
  // 单据→凭证:金额勾稽 / 科目映射 / 汇总(均只读,不写数据)
  { name: "check_voucher_amount",      category: "finance", riskLevel: "safe" },
  { name: "map_voucher_account",       category: "finance", riskLevel: "safe" },
  { name: "summarize_vouchers",        category: "finance", riskLevel: "safe" },
  { name: "build_voucher_lines",       category: "finance", riskLevel: "safe" },
  { name: "build_voucher_sheet",       category: "finance", riskLevel: "safe" },
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

// 确认门要拦截的工具：必须移出 allowedTools，否则 SDK 自动放行、canUseTool 不触发、确认门死。
// 成员与 built-in.ALWAYS_CONFIRM_TOOLS 同步（confirm-gate-fix.test 守无漂移）。
// 注意：不 import built-in（会循环依赖，built-in 已依赖本模块的 getToolRiskLevel）。
// remember_role_convention（刀6）静默写入；remember_convention 仍挂确认门。
const CONFIRM_REQUIRED_TOOL_NAMES = new Set<string>([
  "remember_convention",
  "update_company_profile",
]);

/**
 * 静态工具全集:迁移到 SDK 原生 skill 后,工具不再按 skill 收敛。
 * 模型可见全部已登记工具,由 skill 描述引导选用、高风险工具经确认门兜底(见 createRiskConfirmHook)。
 * 所有内置工具、高风险财务工具与 always-confirm 工具移出此列表，
 * 使其经 canUseTool → risk-confirm hook → 弹确认卡，而非被 SDK 自动放行。
 * 内置工具仍由 BUILTIN_TOOLS 提供定义，并通过 SDK 原生 PreToolUse 机制闸检查。
 */
export const ALLOWED_TOOLS: string[] = TOOL_REGISTRY
  .filter((t) => t.category !== "builtin")
  .filter((t) => !(t.riskLevel === "high" || CONFIRM_REQUIRED_TOOL_NAMES.has(t.name)))
  .map((t) => t.name);

/**
 * SDK 实际加载的内置工具定义集合 —— 只发 agent 真正用得到的内置工具,
 * 替代 `claude_code` 全预设(后者每回合还塞进 Task/TodoWrite/NotebookEdit/BashOutput
 * 等财务 agent 用不到的工具定义;网关无缓存→每回合重复付费)。与 ALLOWED_TOOLS 同源,
 * 不改变可调用能力,仅减少随每回合发送的工具定义体积(MCP 工具走 mcpServers,不在此列)。
 */
export const BUILTIN_TOOLS: string[] = TOOL_REGISTRY.filter((t) => t.category === "builtin").map((t) => t.name);

export function getToolRiskLevel(toolName: string): ToolRiskLevel {
  return TOOL_REGISTRY.find((t) => t.name === toolName)?.riskLevel ?? "medium";
}
