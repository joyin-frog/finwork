/**
 * 角色 UI 映射（client-safe）— spec §2.3
 *
 * tone 值对应 globals.css 里的 CSS 变量名（字符串，运行时通过 style={{ "--tone": ... }} 注入）。
 * iconName 来自 Hugeicons 体系，选语义最贴近的名称。
 *
 * 禁止 import lib/agent 下任何东西（client-safe 约束）。
 */

export type RoleId =
  | "bookkeeper"
  | "payroll-officer"
  | "tax-officer"
  | "treasury-officer"
  | "receivables-officer"
  | "analyst";

export type RoleUiSpec = {
  tone: string;
  iconName: string;
};

/**
 * roleId → 中文岗位名（client-safe，不 import lib/agent）。
 * 注意：此映射应与 lib/agent/roles/registry 中的角色名保持同步；
 * 将来由 role-registry 测试守卫一致性时再收紧（Phase 3）。
 */
export const ROLE_LABELS: Record<string, string> = {
  "bookkeeper":          "记账专员",
  "payroll-officer":     "薪税专员",
  "tax-officer":         "税务专员",
  "treasury-officer":    "资金专员",
  "receivables-officer": "往来专员",
  "analyst":             "经营分析师",
};

/**
 * 数据权限 token → 中文展示名 —— spec docs/spec/spec-agents-ia-ui-polish.md §4.4。
 *
 * 覆盖 ROLE_REGISTRY.dataScope 中出现的机器 token 基名（不改机器语义，只加展示层）。
 * 带括注的长串（如 "fact_payroll（全产品唯一…）"）走 DATA_SCOPE_FULL_LABELS 整串覆盖，
 * 优先于基名切分，避免拼接出生硬的中英混排。
 */
const DATA_SCOPE_BASE_LABELS: Record<string, string> = {
  documents: "文档资料",
  fact_invoices: "发票流水",
  fact_payroll: "工资明细",
  fact_metrics: "经营指标",
  fact_obligations: "收付义务",
  company_profile: "企业档案",
};

const DATA_SCOPE_FULL_LABELS: Record<string, string> = {
  "fact_payroll（全产品唯一有工资明细权限的角色）": "工资明细（本角色独有）",
  "fact_invoices（读）": "发票流水（只读）",
  "fact_invoices（sales，direction=out）": "销项发票流水",
  "company_profile（读）": "企业档案（只读）",
  "fact_obligations（读，kind=receive）": "收付义务（应收，只读）",
  "fact_metrics（只读）": "经营指标（只读）",
  "documents 合同收付义务（读）": "合同收付义务（只读）",
};

/** dataScope 原始 token → 展示用中文；已是中文的原样返回，未命中的英文兜底为可读文案（不裸露 id）。 */
export function dataScopeLabel(raw: string): string {
  const trimmed = raw.trim();
  if (DATA_SCOPE_FULL_LABELS[trimmed]) return DATA_SCOPE_FULL_LABELS[trimmed];
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_]*)(.*)$/);
  if (match) {
    const label = DATA_SCOPE_BASE_LABELS[match[1]];
    if (label) return `${label}${match[2]}`;
  }
  if (!/[a-zA-Z]/.test(trimmed)) return trimmed;
  return "数据权限（未分类）";
}

export const ROLE_UI: Record<RoleId, RoleUiSpec> = {
  "bookkeeper": {
    tone: "--tone-invoice",
    iconName: "note-edit",
  },
  "payroll-officer": {
    tone: "--tone-payroll",
    iconName: "user-account",
  },
  "tax-officer": {
    tone: "--tone-tax",
    iconName: "tax",
  },
  "treasury-officer": {
    tone: "--tone-treasury",
    iconName: "dollar-square",
  },
  "receivables-officer": {
    tone: "--tone-receivables",
    iconName: "invoice",
  },
  "analyst": {
    tone: "--tone-analysis",
    iconName: "chart-line-data-01",
  },
};
