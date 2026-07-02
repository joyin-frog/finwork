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
  { name: "mcp__finance_worker__run_python",            category: "finance", riskLevel: "medium" },
  { name: "mcp__finance_worker__spawn_subagent",        category: "finance", riskLevel: "medium" },
  { name: "mcp__finance_worker__search_knowledge", category: "finance", riskLevel: "safe" },
  { name: "mcp__finance_worker__query_knowledge",  category: "finance", riskLevel: "medium" },
  { name: "mcp__finance_worker__read_file",        category: "finance", riskLevel: "safe" },
  // 写入用户约定:hook 层无条件要求用户确认(ALWAYS_CONFIRM)
  { name: "mcp__finance_worker__remember_convention", category: "finance", riskLevel: "medium" },
  // 经营数据登记
  { name: "mcp__finance_worker__record_business_metrics", category: "finance", riskLevel: "medium" },
  { name: "mcp__finance_worker__generate_business_analysis", category: "finance", riskLevel: "safe" },
  // Payroll & reimbursement tools
  { name: "mcp__finance_worker__calculate_payroll_batch",       category: "finance", riskLevel: "high" },
  { name: "mcp__finance_worker__confirm_payroll_period",        category: "finance", riskLevel: "high" },
  { name: "mcp__finance_worker__query_payroll_status",          category: "finance", riskLevel: "safe" },
  { name: "mcp__finance_worker__check_reimbursement_batch",     category: "finance", riskLevel: "safe" },
  { name: "mcp__finance_worker__record_reimbursement_invoices", category: "finance", riskLevel: "medium" },
  // Reconciliation (read-only, never touches payment)
  { name: "mcp__finance_worker__reconcile_bank_statement",      category: "finance", riskLevel: "safe" },
  // Policy / tax tools(Excel/PPT/PDF 处理已迁到 SDK skill + run_python)
  { name: "mcp__finance_worker__read_expense_policy",     category: "finance", riskLevel: "safe" },
  { name: "mcp__finance_worker__tax_calculator",          category: "finance", riskLevel: "safe" },
  // Kingdee MCP tools
  { name: "mcp__kingdee_worker__query_kingdee_accounts",    category: "finance", riskLevel: "safe" },
  { name: "mcp__kingdee_worker__export_kingdee_draft",      category: "finance", riskLevel: "high" },
  { name: "mcp__kingdee_worker__validate_kingdee_voucher",  category: "finance", riskLevel: "medium" },
  { name: "mcp__kingdee_worker__import_kingdee_accounts",   category: "finance", riskLevel: "medium" },
  // 单据→凭证:金额勾稽 / 科目映射 / 汇总(均只读,不写数据)
  { name: "mcp__kingdee_worker__check_voucher_amount",      category: "finance", riskLevel: "safe" },
  { name: "mcp__kingdee_worker__map_voucher_account",       category: "finance", riskLevel: "safe" },
  { name: "mcp__kingdee_worker__summarize_vouchers",        category: "finance", riskLevel: "safe" },
  { name: "mcp__kingdee_worker__build_voucher_lines",       category: "finance", riskLevel: "safe" },
  { name: "mcp__kingdee_worker__build_voucher_sheet",       category: "finance", riskLevel: "safe" },
  // P1 合同归纳:结构化 metadata 起草工具
  { name: "mcp__finance_worker__record_document_metadata",  category: "finance", riskLevel: "medium" },
  // P3: 公司画像（税务筹划）
  { name: "mcp__finance_worker__update_company_profile",    category: "finance", riskLevel: "medium" },
  // 收尾声明最终产物(只写声明标记;真正清理是收尾确定性执行 + 单独审计,不挂确认门)
  { name: "mcp__finance_worker__finalize_deliverable",      category: "finance", riskLevel: "safe" },
];

/**
 * 静态工具全集:迁移到 SDK 原生 skill 后,工具不再按 skill 收敛。
 * 模型可见全部已登记工具,由 skill 描述引导选用、高风险工具经确认门兜底(见 createRiskConfirmHook)。
 */
export const ALLOWED_TOOLS: string[] = TOOL_REGISTRY.map((t) => t.name);

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
