import type { AgentAttachment, AgentIntent, AgentMessage } from "./contracts";

type ContextProfile = {
  skills: string[];
  tools: string[];
};

export type AgentContextPolicy = {
  profiles: string[];
  /** undefined means retain the full enabled Skill listing. */
  skillNames?: string[];
  /** undefined means retain the full production tool catalog. */
  toolIds?: string[];
};

const finance = (name: string) => name;
const kingdee = (name: string) => name;

const FILE_TOOLS = [
  finance("read_document"),
  finance("read_file"),
  finance("analyze_tabular"),
  finance("finalize_deliverable"),
];
const KNOWLEDGE_TOOLS = [
  finance("search_knowledge"),
  finance("query_knowledge"),
  finance("read_file"),
  finance("read_document"),
];
const HANDOFF_TOOLS = [finance("propose_transfer")];

const PROFILES: Record<string, ContextProfile> = {
  payroll: {
    skills: ["payroll-calc", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("calculate_payroll_batch"),
      finance("confirm_payroll_period"),
      finance("query_payroll_status"),
      finance("diff_payroll_period"),
      finance("export_payslips"),
    ],
  },
  reimbursement: {
    skills: ["reimbursement-check", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("check_reimbursement_batch"),
      finance("record_reimbursement_invoices"),
      finance("read_expense_policy"),
    ],
  },
  receivables: {
    skills: ["receivables-ledger", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("query_receivables"),
      finance("query_invoice_ledger"),
      finance("query_sales_invoices"),
      finance("record_sales_invoices"),
      finance("record_invoice_settlement"),
    ],
  },
  bank: {
    skills: ["xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("reconcile_bank_statement"),
      finance("run_bank_recon_batch"),
    ],
  },
  voucher: {
    skills: ["kingdee-draft", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("scan_slip_folder"),
      kingdee("query_kingdee_accounts"),
      kingdee("import_kingdee_accounts"),
      kingdee("check_voucher_amount"),
      kingdee("map_voucher_account"),
      kingdee("summarize_vouchers"),
      kingdee("build_voucher_lines"),
      kingdee("build_voucher_sheet"),
      kingdee("process_voucher_batch"),
      kingdee("validate_kingdee_voucher"),
      kingdee("export_kingdee_draft"),
      kingdee("export_voucher_list"),
    ],
  },
  business: {
    skills: ["business-analysis", "finance-analysis", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("generate_business_analysis"),
      finance("record_business_metrics"),
    ],
  },
  filing: {
    skills: ["filing-precheck", "tax-incentive", "rnd-deduction-check", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("run_filing_precheck_batch"),
      finance("emit_checklist"),
      finance("tax_calculator"),
      finance("update_company_profile"),
    ],
  },
  tax: {
    skills: ["tax-incentive", "rnd-deduction-check", "xlsx"],
    tools: [
      ...FILE_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...HANDOFF_TOOLS,
      finance("tax_calculator"),
      finance("update_company_profile"),
      finance("emit_checklist"),
    ],
  },
  document: {
    skills: ["contract-extract", "docx", "pdf"],
    tools: [
      ...FILE_TOOLS,
      ...KNOWLEDGE_TOOLS,
      finance("record_document_metadata"),
    ],
  },
  knowledge: {
    skills: [],
    tools: KNOWLEDGE_TOOLS,
  },
  batch: {
    skills: [],
    tools: [
      finance("spawn_subagent"),
      finance("run_bank_recon_batch"),
      finance("run_filing_precheck_batch"),
      finance("propose_transfer"),
    ],
  },
  memory: {
    skills: [],
    tools: [finance("remember_convention")],
  },
  undo: {
    skills: [],
    tools: [finance("undo_last_write")],
  },
};

const PROFILE_PATTERNS: Array<[string, RegExp]> = [
  ["payroll", /工资|薪资|个税|发薪|算薪|工资表/],
  ["reimbursement", /报销|差旅费|费用报销|重复报销/],
  ["receivables", /应收|账龄|催款|销项发票|回款/],
  ["bank", /银行对账|流水对账|银行流水/],
  ["voucher", /金蝶|记账凭证|做凭证|录凭证|科目映射|借贷平衡|单据.{0,4}记账/],
  [
    "business",
    /经营分析|财务比率|杜邦|同比|环比|预算对比|预算差异|预算执行|财务数据分析|费用.{0,4}汇总|分析附件|分析.{0,6}(表|数据)/,
  ],
  ["filing", /申报前|报税前|申报复核/],
  ["tax", /税收优惠|税务优惠|研发加计|加计扣除|减免|补贴/],
  ["document", /合同要点|提取.{0,6}(合同|订单|发票|账单)|文档要点/],
  [
    "batch",
    /(?:至少|超过|共)?[三四五六七八九十\\d]+个.{0,8}(任务|主体|公司)|并行派发|批量派发|并行派.{0,6}(专员|角色)|分别.{0,8}(分析|处理).{0,8}[三四五六七八九十\\d]+个.{0,8}(部门|主体|公司)/,
  ],
  ["memory", /以后.{0,20}(都|要|请|记得)|长期.{0,12}(遵守|记住)|记住这个(习惯|约定|规则)/],
  ["undo", /撤销.{0,8}(操作|写入|登记)|撤回刚才|undo/i],
];

const EXTENSION_SKILLS: Array<[RegExp, string]> = [
  [/\.(xlsx|xlsm|xls|csv|tsv)$/i, "xlsx"],
  [/\.docx?$/i, "docx"],
  [/\.pdf$/i, "pdf"],
  [/\.pptx?$/i, "pptx"],
];

const REQUESTED_OUTPUT_SKILLS: Array<[RegExp, string]> = [
  [/(?:生成|导出|交付|制作).{0,40}(?:Excel|XLSX|电子表格|工作簿)/i, "xlsx"],
  [/(?:生成|导出|交付|制作).{0,40}(?:Word|DOCX|文档|简报)/i, "docx"],
  [/(?:生成|导出|交付|制作).{0,40}(?:PDF)/i, "pdf"],
  [/(?:生成|导出|交付|制作).{0,40}(?:PPT|PPTX|演示文稿)/i, "pptx"],
];

/**
 * Conservative, deterministic progressive disclosure.
 *
 * A recognized domain gets only its Skill listings and tools. Unknown or
 * ambiguous general work returns undefined sets, preserving the complete
 * catalog instead of guessing. Multiple recognized domains are unioned.
 */
export function resolveAgentContextPolicy(input: {
  messages: AgentMessage[];
  attachments?: AgentAttachment[];
  intent?: AgentIntent;
}): AgentContextPolicy {
  const current = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const profiles = new Set<string>();
  for (const [name, pattern] of PROFILE_PATTERNS) {
    if (pattern.test(current)) profiles.add(name);
  }
  if (input.intent === "rag_qa") profiles.add("knowledge");

  const fileSkills = new Set<string>();
  for (const attachment of input.attachments ?? []) {
    for (const [pattern, skill] of EXTENSION_SKILLS) {
      if (pattern.test(attachment.name)) fileSkills.add(skill);
    }
  }
  for (const [pattern, skill] of REQUESTED_OUTPUT_SKILLS) {
    if (pattern.test(current)) fileSkills.add(skill);
  }

  if (/先.{0,8}(?:发起|请求|进行)?导出确认|先确认.{0,8}导出/.test(current)) {
    return {
      profiles: ["voucher_export_confirmation"],
      skillNames: [...new Set(["kingdee-draft", ...fileSkills])],
      toolIds: [kingdee("export_kingdee_draft")],
    };
  }

  if (/批量生成.{0,10}凭证.{0,8}(?:草稿|预览)/.test(current)) {
    return {
      profiles: ["voucher_batch"],
      skillNames: [...new Set(["kingdee-draft", ...fileSkills])],
      toolIds: [kingdee("process_voucher_batch")],
    };
  }

  if (profiles.size === 0 && fileSkills.size === 0) {
    return { profiles: [] };
  }

  const skills = new Set(fileSkills);
  const tools = new Set<string>();
  if (fileSkills.size > 0) FILE_TOOLS.forEach((tool) => tools.add(tool));
  for (const profileName of profiles) {
    const profile = PROFILES[profileName];
    profile.skills.forEach((skill) => skills.add(skill));
    profile.tools.forEach((tool) => tools.add(tool));
  }
  return {
    profiles: [...profiles],
    skillNames: [...skills],
    toolIds: [...tools],
  };
}
