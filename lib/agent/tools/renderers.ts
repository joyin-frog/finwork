import { getRoleDefinition } from "@/lib/agent/roles/registry";

type SummaryFn = (input: unknown, result?: string, isError?: boolean) => string;

/** 技能 id → 中文名(过程展示用人话,不露 finance-skills:business-analysis 机器 id)。 */
const SKILL_LABELS: Record<string, string> = {
  "business-analysis": "经营分析",
  "finance-analysis": "财务分析",
  "reimbursement-check": "报销核对",
  "payroll-calc": "薪税计算",
  "kingdee-draft": "金蝶凭证",
  "tax-incentive": "税务优惠",
  "rnd-deduction-check": "研发加计",
  xlsx: "表格处理", pdf: "PDF 处理", docx: "Word 处理", pptx: "PPT 处理",
};
function skillLabel(id: string): string {
  const bare = id.replace(/^finance-skills:/, "").replace(/^.*:/, "");
  return SKILL_LABELS[bare] ?? bare;
}

const summaries: Record<string, SummaryFn> = {
  Read:       (i) => `读取 ${shortPath(str(i, "file_path"))}`,
  Write:      (i) => `写入 ${shortPath(str(i, "file_path"))}`,
  Edit:       (i) => `编辑 ${shortPath(str(i, "file_path"))}`,
  MultiEdit:  (i) => `编辑 ${shortPath(str(i, "file_path"))}`,
  Glob:       (i) => `查找文件 ${str(i, "pattern")}`,
  Grep:       (i) => `搜索「${str(i, "pattern")}」`,
  Bash:       (i) => { const cmd = str(i, "command"); return cmd ? `执行：${cmd.slice(0, 60)}` : "执行命令"; },
  WebSearch:  (i) => `搜索「${str(i, "query")}」`,
  WebFetch:   (i) => `获取 ${str(i, "url").slice(0, 60)}`,
  Monitor:    () => "监控进程",
  Skill:      (i) => { const n = str(i, "command") || str(i, "name") || str(i, "skill"); return n ? `调用【${skillLabel(n)}】技能` : "调用技能"; },

  AskUserQuestion: (i) => {
    const qs = (i as { questions?: Array<{ question?: string }> })?.questions;
    return qs?.[0]?.question ? `询问：${qs[0].question.slice(0, 60)}` : "询问用户";
  },

  run_python: (i, r) => {
    const intent = pythonCodeIntent(str(i, "code"));
    if (!r) return intent ? `运行 Python:${intent}` : "执行 Python";
    const m = r.match(/生成的文件[：:]\n((?:- .+\n?)+)/);
    if (m) {
      const names = (m[1].match(/^- (.+?) \(/gm) ?? []).map((s) => s.replace(/^- /, "").replace(/ \($/, ""));
      if (names.length === 1) return `生成文件 ${names[0]}`;
      return `生成 ${names.length} 个文件`;
    }
    // 没产出文件时,用代码意图代替死板的"执行成功",让过程看得懂在干嘛
    return intent ? `运行 Python:${intent}` : "执行 Python";
  },

  // ─── 财务工具(finance_worker) ───
  search_knowledge: (i) => { const q = str(i, "query"); return q ? `检索知识库「${q.slice(0, 30)}」` : "检索知识库"; },
  query_knowledge: (i) => { const c = str(i, "command"); return c ? `知识库命令检索:${c.slice(0, 50)}` : "知识库命令检索"; },
  read_file: (i) => { const f = str(i, "fileName"); return f ? `读取知识库文件 ${f}` : "读取知识库文件"; },
  remember_convention: (i) => { const t = str(i, "text"); const r = str(i, "replaces"); return t ? (r ? `更新约定「${t.slice(0, 40)}」` : `记住约定「${t.slice(0, 40)}」`) : (r ? `取消约定「${r.slice(0, 40)}」` : "更新工作约定"); },
  record_business_metrics: (i) => {
    const rows = Array.isArray((i as Record<string, unknown>)?.rows) ? (i as Record<string, unknown>).rows as unknown[] : [];
    return `登记经营数据(${rows.length} 个月)`;
  },
  generate_business_analysis: (i) => {
    const rec = i as Record<string, unknown>;
    const hasBudget = Boolean(rec?.budget);
    const hasPrior  = Boolean((rec?.incomeStatement as Record<string, unknown> | undefined)?.prior);
    if (hasBudget || hasPrior) return "生成经营分析表(四能力×三基准)";
    return "生成经营分析表(偿债/盈利/营运/发展)";
  },
  spawn_subagent: (i) => {
    // 新参数 role(角色 id);历史会话事件里存的是旧参数 skill,保留兼容渲染
    const roleName = getRoleDefinition(str(i, "role"))?.name;
    const legacySkill = str(i, "skill");
    const who = roleName ?? (legacySkill ? skillLabel(legacySkill) : "");
    const label = str(i, "label");
    const suffix = label && label !== "subagent" ? `:${label}` : "";
    return who ? `派给${who}${suffix}` : `执行子任务${suffix}`;
  },
  calculate_payroll_batch: (i) => {
    const period = formatPeriod(i);
    const count = arrayLen(i, "employees");
    return `计算${period}工资${count ? `(${count} 人)` : ""}`;
  },
  confirm_payroll_period: (i) => `确认${formatPeriod(i)}工资生效`,
  query_payroll_status: (i) => `查询${formatPeriod(i)}工资确认状态`,
  check_reimbursement_batch: (i) => { const count = arrayLen(i, "items"); return `核对报销单${count ? `(${count} 条)` : ""}`; },
  record_reimbursement_invoices: (i) => { const count = arrayLen(i, "items"); return `登记报销发票${count ? `(${count} 张)` : ""}进台账`; },
  reconcile_bank_statement: (i) => { const bank = arrayLen(i, "bankRows"); const book = arrayLen(i, "bookRows"); return `银行流水对账(银行 ${bank} 笔 / 账面 ${book} 笔)`; },
  read_expense_policy: (i) => `查阅报销制度(${str(i, "section") || "全部"})`,
  tax_calculator: (i) => {
    const kind = str(i, "type") === "cit" ? "企业所得税" : "增值税";
    const amount = num(i, "amount");
    return `计算${kind}${amount != null ? `(金额 ${amount.toLocaleString("zh-CN")} 元)` : ""}`;
  },

  // P1 合同归纳
  record_document_metadata: (i) => {
    const docType = str(i, "docType") || ((i as Record<string, unknown>)?.metadata && str((i as Record<string, unknown>).metadata, "docType")) || "文档";
    return `提炼「${docType}」要点`;
  },

  // ─── P3: 公司画像 ───
  update_company_profile: (i) => {
    const patch = (i && typeof i === "object") ? i as Record<string, unknown> : {};
    const patchKeys = Object.keys((patch.patch && typeof patch.patch === "object") ? patch.patch as Record<string, unknown> : patch)
      .filter((k) => k !== "idempotency_key");
    return patchKeys.length ? `更新公司画像（${patchKeys.join("、")}）` : "更新公司画像";
  },

  // ─── 收尾:声明最终产物 ───
  finalize_deliverable: (i) => {
    const files = Array.isArray((i as Record<string, unknown>)?.files) ? (i as Record<string, unknown>).files as unknown[] : [];
    const names = files.map((f) => String(f)).filter(Boolean);
    if (names.length === 1) return `确定交付 ${names[0]}`;
    return names.length ? `确定交付 ${names.length} 个文件` : "确定最终交付";
  },

  // ─── 金蝶工具(kingdee_worker) ───
  query_kingdee_accounts: (i) => {
    const filter = str(i, "accountName") || str(i, "accountCode");
    return `查询金蝶科目${filter ? `「${filter}」` : "表"}`;
  },
  export_kingdee_draft: (i) => { const period = str(i, "period"); return `导出金蝶凭证草稿${period ? `(${period})` : ""}`; },
  validate_kingdee_voucher: () => "校验金蝶凭证(借贷平衡/科目)",
  import_kingdee_accounts: (i) => {
    const a = (i as { accounts?: unknown[] }).accounts;
    const n = Array.isArray(a) ? a.length : 0;
    return `导入金蝶科目表${n ? `(${n} 个科目)` : ""}`;
  },
};

/** 从 Python 代码提炼一句人话「目的」:仅当能认出操作的具名数据文件时给「处理《X》」,否则返回空(UI 兜底「运行代码」)。 */
function pythonCodeIntent(code: string): string {
  if (!code) return "";
  // 只认「引用了具名数据文件」这一种可读目的(对应用户要的「分析 xx 文件」);其余一律不猜——
  // 宁可回落「运行代码」,也不把 `rev = Decimal(...)` 这类原始代码语句当目的露出来。
  const fileRef = code.match(/['"]([^'"\n]+\.(?:xlsx|xlsm|csv|pdf|docx|pptx))['"]/i);
  if (fileRef) {
    const base = (fileRef[1].replace(/\\/g, "/").split("/").pop() ?? fileRef[1]).replace(/\.[^.]+$/, "").trim();
    if (base) return `处理《${base}》`;
  }
  return "";
}

/** 把工具报错(退出码/stderr)压成一句人话:已知码直接译,Python 异常取末行,实在不知道→执行失败。 */
function summarizeToolError(result: string): string {
  const text = result ?? "";
  const code = text.match(/exit code (\d+)|退出码 (\d+)/i);
  const n = code ? Number(code[1] ?? code[2]) : null;
  const byCode: Record<number, string> = {
    127: "命令未找到", 126: "无法执行", 124: "执行超时", 137: "被终止（超时/内存）",
  };
  if (n != null && byCode[n]) return byCode[n];
  if (/command not found|not found/i.test(text)) return "命令未找到";
  // Python/异常:取最后一条异常行(真正的原因),而非最没用的首行退出码
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const exc = [...lines].reverse().find((l) => /\w*(Error|Exception):/.test(l));
  if (exc) return exc.slice(0, 80);
  return "执行失败";
}

function formatPeriod(input: unknown): string {
  const year = num(input, "year");
  const month = num(input, "month");
  return year != null && month != null ? ` ${year}年${month}月 ` : "本期";
}

export function getToolSummary(
  toolName: string,
  input?: unknown,
  result?: string,
  isError?: boolean
): string {
  if (isError && result) {
    return `错误：${summarizeToolError(result)}`;
  }
  const bare = toolName.replace(/^mcp__\w+__/, "");
  const fn = summaries[bare] ?? summaries[toolName];
  return fn ? fn(input, result, isError) : formatToolLabel(toolName);
}

/** 该工具是否有专门的摘要文案(用于校验财务工具不落入英文兜底)。 */
export function hasToolSummary(toolName: string): boolean {
  const bare = toolName.replace(/^mcp__\w+__/, "");
  return Boolean(summaries[bare] ?? summaries[toolName]);
}

export function formatToolLabel(name: string): string {
  return name
    .replace(/^mcp__\w+__/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function str(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function num(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function arrayLen(input: unknown, key: string): number {
  if (!input || typeof input !== "object") return 0;
  const v = (input as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.length : 0;
}

function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}
