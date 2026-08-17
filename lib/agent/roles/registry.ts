import { TOOL_REGISTRY, ALLOWED_TOOLS } from "@/lib/agent/tools/registry";

/** 角色越权边界条目：说明不可做事项及应转交的目标角色 id。供概况页展示与运行时提示复用。 */
export type RoleBoundary = {
  cannot: string;     // 不可做的事，财务语言描述
  transferTo: string; // 应转交的目标角色 id（须为有效 roleId）
};

export type RoleDefinition = {
  id: string;                 // 稳定 id，进 dispatches 表与 spawn 枚举
  name: string;               // 中文名，UI 展示
  domain: string;             // 职能大类
  charter: string;            // 一句话职责，UI 副标题
  available: boolean;         // false = 注册表预留但主 Agent 不可派发（作业未落地）
  skills: string[];           // 派发时传 SDK 的技能白名单（须存在于技能目录）
  tools: string[];            // 领域工具白名单；实际生效 = 与 ALLOWED_TOOLS 取交集 + SHARED_TOOLS
  dataScope: string[];        // 数据域说明（文档性质；执行靠 tools + pathSafety）
  deliverables: string[];     // 输出契约类型，主 Agent 按此汇总
  rolePrompt: string;         // B 段角色定位（见 §3）
  boundaries: RoleBoundary[]; // 越权边界映射（D1·刀8）；transferTo 必须是有效 roleId
};

// 所有角色共享的底座工具（现状内置文件/检索工具照旧放行，不在此列）
export const SHARED_TOOLS = [
  "analyze_tabular", "search_knowledge", "query_knowledge", "read_file", "read_document",
  "list_workspace_files", "read_workspace_file", "patch_workspace_workbook", "begin_workspace_change", "review_workspace_change",
  "inspect_document_structure", "finalize_deliverable",
];

export const ROLE_REGISTRY: RoleDefinition[] = [
  {
    id: "bookkeeper",
    name: "记账专员",
    domain: "核算与报告",
    charter: "凭证编制与审核、发票台账、结账核对",
    available: true,
    skills: ["reimbursement-check", "kingdee-draft", "contract-extract", "xlsx", "pdf"],
    tools: [
      "check_reimbursement_batch", "record_reimbursement_invoices", "read_expense_policy",
      "query_invoice_ledger",
      "record_document_metadata", "query_kingdee_accounts", "validate_kingdee_voucher",
      "patch_document",
      "export_kingdee_draft",   // high：子代理内被确认门拒，白名单表达域归属
      // 单据→凭证(voucher-from-slips 合入后补挂,2026-07-02)
      "read_document", "scan_slip_folder", "check_voucher_amount", "map_voucher_account",
      "build_voucher_lines", "build_voucher_sheet", "summarize_vouchers", "process_voucher_batch",
    ],
    dataScope: ["documents", "fact_invoices", "金蝶科目表", "报销制度文件"],
    deliverables: ["voucher_draft", "risk_list", "ledger_entries"],
    boundaries: [
      { cannot: "薪资及个税相关凭证编制（须以已确认的汇总数为源）", transferTo: "payroll-officer" },
      { cannot: "纳税申报合规性判断与申报前复核", transferTo: "tax-officer" },
      { cannot: "银行流水与账面核对、资金日报", transferTo: "treasury-officer" },
      { cannot: "应收应付账龄分析与催款清单", transferTo: "receivables-officer" },
    ],
    rolePrompt: `你是记账专员，负责核算与报告域：报销单据合规核查与发票台账登记、
原始单据到金蝶凭证草稿、合同要点结构化、月末结账前检查。
边界（违反即任务失败）：
- 只出凭证「草稿」，正式入账永远由人在金蝶里完成；
- 不读取、不推算任何员工工资明细；工资相关凭证只用已确认期间的汇总数；
- 科目选择有判断成分时（如餐费归招待费/福利费/差旅费），给出建议 + 依据 + 备选，不静默定案；
- 发票查重命中历史台账时，原样列出两条记录供人比对，不自行裁决。
接到核算域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
  {
    id: "payroll-officer",
    name: "薪税专员",
    domain: "薪酬核算",
    charter: "薪资核算、五险一金、个税代扣代缴",
    available: true,
    skills: ["payroll-calc", "xlsx"],
    tools: [
      "calculate_payroll_batch",  // high：子代理内被确认门拒；试算准备类任务仍可承接
      "query_payroll_status", "tax_calculator", "diff_payroll_period",
      "export_payslips",
    ],
    dataScope: ["fact_payroll（全产品唯一有工资明细权限的角色）", "税率配置"],
    deliverables: ["payroll_draft", "calc_receipt", "diff_list", "payslip_sheet"],
    boundaries: [
      { cannot: "代扣代缴之外的纳税申报（如增值税、企业所得税申报）", transferTo: "tax-officer" },
      { cannot: "报销单据合规性核查与凭证编制", transferTo: "bookkeeper" },
      { cannot: "应收应付台账与往来对账", transferTo: "receivables-officer" },
      { cannot: "银行流水核对与资金到期管理", transferTo: "treasury-officer" },
    ],
    rolePrompt: `你是薪税专员，负责薪酬核算域：按累计预扣预缴法算工资个税、
五险一金核对、社保基数与专项附加扣除的口径检查。
边界（违反即任务失败）：
- 个税一律走确定性工具计算，禁止心算；年度累计制，必须接力本年已确认月份的累计数；
- 你产出的一切都是草稿；期间确认（confirm_payroll_period）不归你，永远由主对话的人完成；
- 员工姓名之外的个人敏感信息（身份证号、银行卡号）不写入结果正文，引用时用掩码；
- 与上月已确认数据有差异的员工，逐个列出差异项和原因猜测，排在结果最前。
接到薪酬域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
  {
    id: "tax-officer",
    name: "税务专员",
    domain: "税务管理",
    charter: "纳税申报管理、申报前复核、税收优惠",
    available: true,
    skills: ["tax-incentive", "rnd-deduction-check", "xlsx"],
    // filing-precheck v1 由主对话直接执行（主对话拥有画像注入、工具权限和问用户通道三者；
    // 子代理 buildSubagentSystemPrompt 不注入画像，且子代理无与用户对话通道——挂载此数组
    // 只会产出全"无法核验"清单）。子代理画像注入机制落地后，再将 "filing-precheck" 加入此数组。
    tools: ["tax_calculator", "query_payroll_status", "query_invoice_ledger"],
    dataScope: ["fact_invoices（读）", "company_profile（读）", "薪资状态汇总（非明细）", "知识库政策文件"],
    deliverables: ["risk_list", "checklist"],
    boundaries: [
      { cannot: "薪资个税以外的工资核算与社保基数核对", transferTo: "payroll-officer" },
      { cannot: "报销发票合规核查与凭证编制", transferTo: "bookkeeper" },
      { cannot: "应收应付账龄分析", transferTo: "receivables-officer" },
      { cannot: "银行流水核对与资金日报", transferTo: "treasury-officer" },
    ],
    rolePrompt: `你是税务专员，负责税务管理域：申报日历与截止提醒、申报前复核、
税收优惠线索发现、研发加计扣除形式核查。
边界（违反即任务失败）：
- 不提交任何申报；不替用户拍「该不该这么处理」的板，只给依据、影响和可选项；
- 不读取员工工资明细，个税申报一致性核对只用已确认期间的汇总数；
- 政策结论必须带来源与时效标注，查不到就写「未核实当年政策」，禁止凭记忆断言税率或标准；
- 优惠线索只做「形式匹配 + 要件清单」，适用性判断明确标注需专业人士确认。
接到税务域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
  {
    id: "treasury-officer",
    name: "资金专员",
    domain: "资金管理",
    charter: "银行对账、资金日报、到期付款提示",
    available: true,
    skills: ["xlsx"],  // 待建：cash-daily（资金日报）
    tools: ["reconcile_bank_statement"],
    dataScope: ["银行流水文件（用户上传）", "documents 合同收付义务（读）"],
    deliverables: ["recon_report", "risk_list"],
    boundaries: [
      { cannot: "应收应付台账与账龄分析", transferTo: "receivables-officer" },
      { cannot: "凭证编制与发票台账登记", transferTo: "bookkeeper" },
      { cannot: "薪资核算与个税计算", transferTo: "payroll-officer" },
    ],
    rolePrompt: `你是资金专员，负责资金管理域：银行流水与账面核对、余额与收付汇总、
合同收付义务的到期提醒。
边界（违反即任务失败）：
- 你的一切操作只读；付款执行、网银操作与你无关，连「代拟付款指令」也不做；
- 对不上的流水逐笔列出（日期、金额、摘要、可能原因），禁止静默跳过或模糊汇总；
- 多账户合并时按账户分列再合计，明细之和必须等于合计（尾差显式说明）。
接到资金域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
  {
    id: "receivables-officer",
    name: "往来专员",
    domain: "往来管理",
    charter: "应收应付台账、账龄分析、往来对账",
    // 转正日期：2026-07-07（WP13a：fact_obligations 数据域已就绪，receivables-ledger 技能已建）
    available: true,
    skills: ["receivables-ledger", "xlsx"],
    tools: [
      "query_receivables",
      // WP13b: 销项发票层（登记 + 回款 + 查询）
      "record_sales_invoices",
      "record_invoice_settlement",
      "query_sales_invoices",
    ],
    dataScope: ["fact_obligations（读，kind=receive）", "fact_invoices（sales，direction=out）", "documents 合同收付义务（读）"],
    deliverables: ["aging_report", "dunning_list"],
    boundaries: [
      { cannot: "凭证编制与发票合规核查", transferTo: "bookkeeper" },
      { cannot: "薪资核算与个税代扣", transferTo: "payroll-officer" },
      { cannot: "纳税申报与税收优惠核查", transferTo: "tax-officer" },
    ],
    rolePrompt: `你是往来专员，负责往来管理域：应收应付台账、账龄分析、
催款清单、与客户/供应商的对账单核对。
边界（违反即任务失败）：
- 催款函、对账函只出草稿，发送永远由人完成；
- 账龄口径在结果中显式声明（合同义务层自约定回款日起算；销项发票层自开票日起算——使用 query_sales_invoices 工具获取发票层账龄）；
- 对账差异逐笔列出，区分「我方漏记 / 对方漏记 / 时间性差异」三类。
接到往来域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
  {
    id: "analyst",
    name: "经营分析师",
    domain: "管理会计",
    charter: "费用与毛利分析、同比环比、经营指标解读",
    available: true,
    skills: ["business-analysis", "finance-analysis", "xlsx", "docx", "pptx"],
    // record_business_metrics 不进白名单(PR #16 review 修复,2026-07-02):该工具 riskLevel=medium,
    // 子代理内确认门只拦 high/ALWAYS_CONFIRM,子代理可无人确认写入 business_metrics——
    // 会把分析师的"推测"结论静默升级成 user_dictated 事实源,踩红线 3。写权限收回主对话(人在场可走确认)。
    tools: ["generate_business_analysis", "patch_document", "research_web"],
    dataScope: ["fact_metrics（只读）", "用户上传的报表/费用/工资汇总文件"],
    deliverables: ["analysis_report", "metric_table"],
    boundaries: [
      { cannot: "薪酬明细核算与个税计算", transferTo: "payroll-officer" },
      { cannot: "凭证编制与发票核查", transferTo: "bookkeeper" },
      { cannot: "纳税申报与税务复核", transferTo: "tax-officer" },
    ],
    rolePrompt: `你是经营分析师，负责管理会计域：经营数据分析、费用拆解、
财务比率、环比同比与趋势解读。
边界（违反即任务失败）：
- 你的所有结论属于「推测」层，输出必须可被标注为分析结论，不得写成事实断言；
- 任何跨期对比先检查两端口径与结算状态是否一致：草稿期数据不与已结账期并列比较，
  口径变了先说口径，再说业务；
- 环比异动的解释顺序固定：口径动没动 → 数据全不全 → 业务动没动；
- 你没有登记经营数据的工具权限：分析产生的数字不得回写为经营事实，
  发现用户提到新的经营数字时，如实告知需要由用户在主对话中确认后登记。
接到管理会计域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
];

export function getRoleDefinition(id: string): RoleDefinition | undefined {
  return ROLE_REGISTRY.find((r) => r.id === id);
}

/**
 * 解析角色的实际可用工具全名列表。
 *
 * 组成 = builtin 工具（category==="builtin"）+ SHARED_TOOLS 与 role.tools 中登记的工具名。
 * 工具名直接在 TOOL_REGISTRY 中校验，否则抛错（fail-fast，防注册表写错工具名）。
 * 返回值必然 ⊆ ALLOWED_TOOLS。
 */
export function resolveRoleAllowedTools(roleId: string): string[] {
  const allowedSet = new Set<string>(ALLOWED_TOOLS);
  // 确保结果 ⊆ ALLOWED_TOOLS
  return resolveRoleScopeTools(roleId).filter((t) => allowedSet.has(t));
}

/**
 * 角色的职责域工具全集（E 刀·专员会话）：与 resolveRoleAllowedTools 同源，
 * 但**不**与 ALLOWED_TOOLS 取交集——包含角色域内的高风险工具（如薪税的 calculate_payroll_batch）。
 * 用途：专员会话的 role-scope hook 以此为边界——域内高风险工具放行到确认门（交互式会话可弹确认卡），
 * 域外工具（含 spawn_subagent 与其他角色的工具）一律 deny。
 */
export function resolveRoleScopeTools(roleId: string): string[] {
  const role = getRoleDefinition(roleId);
  if (!role) {
    throw new Error(`resolveRoleScopeTools: 未知角色 "${roleId}"`);
  }

  const toolFullNameSet = new Set<string>(TOOL_REGISTRY.map((t) => t.name));

  function resolveBare(bare: string): string {
    // 如果已经是全名（builtin 工具如 "Read"）
    if (toolFullNameSet.has(bare)) return bare;
    throw new Error(`resolveRoleScopeTools: 裸名 "${bare}" 在 TOOL_REGISTRY 中找不到对应全名`);
  }

  const result = new Set<string>();

  // 1. builtin 工具（category === "builtin"）
  for (const t of TOOL_REGISTRY) {
    if (t.category === "builtin") {
      result.add(t.name);
    }
  }

  // 2. SHARED_TOOLS 裸名解析
  for (const bare of SHARED_TOOLS) {
    result.add(resolveBare(bare));
  }

  // 3. role.tools 裸名解析
  for (const bare of role.tools) {
    result.add(resolveBare(bare));
  }

  return Array.from(result);
}
