/**
 * 任务模板表（spec-task-templates §3 步骤 1）
 *
 * 各角色预定义的命名任务模板，用于：
 * - 派活按钮的模板菜单（agent-card.tsx）
 * - spawn_subagent 的 task_template 参数展开
 * - subagent_dispatches 表的 task_template_id / business_object / period 落盘
 *
 * 注意：promptTemplate 逐条对照了 registry.ts 对应角色 rolePrompt 的边界条款。
 */

export type TaskTemplate = {
  id: string;           // 全局唯一，进 dispatches 表
  roleId: string;       // 归属角色
  name: string;         // UI 名（如「结账前检查」）
  description: string;  // 一句话，进 spawn cheatsheet 与派活菜单副标题
  mode: "subagent" | "main-skill";
  skillName?: string;   // mode=main-skill 必填
  needsFiles?: boolean; // 派活话术提示附文件
  objectLabel?: string; // 默认业务对象（写入 business_object）
  promptTemplate?: string; // mode=subagent 必填，含 {{period}} 占位符
};

/**
 * 全局模板注册表。
 * 边界核查记录（逐条对照 rolePrompt）：
 * - bookkeeper month-close-precheck：含工资计提边界约束句，不推算明细，只核汇总数
 * - payroll-officer payroll-review：明确"只复核不计算、不确认期间"，不踩 confirm_payroll_period 边界
 * - tax-officer filing-precheck：mode=main-skill，无 promptTemplate，子代理不可派发（registry 注释已说明）
 * - treasury-officer bank-recon：只读操作，对不上的流水逐笔列出，遵循不静默跳过边界
 * - receivables-officer dunning-list：账龄口径显式声明，只出草稿，遵循对账差异逐笔列出边界
 */
export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "month-close-precheck",
    roleId: "bookkeeper",
    name: "结账前检查",
    description: "核查本期凭证完整性、发票台账一致性与应计提项提醒",
    mode: "subagent",
    objectLabel: "结账清单",
    promptTemplate: `请对 {{period}} 期间做结账前检查：
1. 核对本期凭证完整性（含凭证序号断档、借贷不平衡、凭证无附件等异常）；
2. 核查发票台账与入账一致性（有入账凭证但无台账记录、或台账已登记但无对应凭证行）；
3. 应计提项提醒清单（折旧、摊销、预提费用等）；工资计提只核查是否已有对应凭证行及金额是否与已确认期间汇总一致，不查员工明细；
产出：按风险从高到低排序的检查清单；查不了的项显式列入「无法核验」区块，不得静默跳过。`,
  },
  {
    id: "payroll-review",
    roleId: "payroll-officer",
    name: "薪资试算复核",
    description: "与上月已确认期间对比，逐人列差异项与原因",
    mode: "subagent",
    objectLabel: "薪资期间",
    promptTemplate: `请对 {{period}} 薪资期间做试算复核：
用 diff_payroll_period 工具与上月（或上年同期）已确认期间对比，逐人列出差异项与原因猜测，排在结果最前；
产出：差异明细表 + 无差异汇总行数；
明确：只复核不计算、不确认期间；期间确认（confirm_payroll_period）永远由主对话人完成。`,
  },
  {
    id: "filing-precheck",
    roleId: "tax-officer",
    name: "申报前复核",
    description: "申报前检查个税与增值税数据是否就绪（主对话执行）",
    mode: "main-skill",
    skillName: "filing-precheck",
    // 无 promptTemplate：此模板为 main-skill 型，由主对话经 /filing-precheck 技能执行
    // 子代理无画像注入、无问用户通道，registry.ts:79-82 已说明不可经 spawn_subagent 派发
  },
  // ── 申报前复核批跑子模板（spec-filing-precheck-batch §3 步骤 1）──────────────
  // 边界核查：逐条对照 registry.ts tax-officer rolePrompt（85-92 行）：
  //   - 不提交申报 ✓  - 不替用户拍板 ✓  - 个税只用已确认汇总数 ✓
  //   - 政策结论带「需核实当年政策」 ✓  - 子代理无与用户对话通道 ✓
  {
    id: "vat-filing-precheck",
    roleId: "tax-officer",
    name: "增值税及附加复核",
    description: "申报前核对本期增值税进项/销项台账，识别未认证/方向未知发票等阻塞项",
    mode: "subagent",
    objectLabel: "增值税及附加",
    promptTemplate: `请对 {{period}} 期间做增值税及附加申报前复核：

调用 query_invoice_ledger 时，请把期间 {{period}} 拆为 year（整数）与 month（整数）两个参数分别传入。

【本期台账概况】
- 本期发票总张数：query_invoice_ledger 返回的 total；
- 本期进项张数与税额：directionIn.count 与 directionIn.taxAmountCentsSum（单位：分，换算元时除以 100）；
- 本期销项张数（推算口径）：total − directionIn.count；结果中须显式说明此为推算值、无独立销项字段。

【口径声明——必读】
query_invoice_ledger 返回的 uncertifiedCount（未认证进项张数）与 directionUnknownCount（方向未知张数）
是全库累计口径、不按 invoice_date 过滤，不限于本期。
输出中这两个数字必须标注"全库累计（含历史）"，禁止写成"本期未认证"或"本期方向未知"。

【输出检查清单（按风险从高到低排序）】
① 全库累计未认证进项（标注"全库累计（含历史）"口径，说明张数及对进项税额抵扣的潜在影响）；
② 方向未知发票需人工归类（标注"全库累计（含历史）"口径，说明张数）；
③ 本期台账为空或数据明显不全时列"无法核验"并说明缺什么；

附加税（城建税、教育附加、地方教育附加）按增值税联动，本期适用附加税影响一句带过即可。

一切税率与申报期限结论须标注「需核实当年政策」，禁止凭记忆断言。
不替用户判断申报数据对错，只给核对项与依据。`,
  },
  {
    id: "iit-filing-precheck",
    roleId: "tax-officer",
    name: "个税申报一致性复核",
    description: "核对已确认薪资期间与扣缴端申报表（人数、税额），识别期间未确认等阻塞项",
    mode: "subagent",
    objectLabel: "个税",
    promptTemplate: `请对 {{period}} 期间做个税申报一致性复核：

调用 query_payroll_status 时，请把期间 {{period}} 拆为 year（整数）与 month（整数）两个参数分别传入。

【阻塞项优先检查（排最前）】
若 confirmed 为空，或 drafts 非空（存在未确认草稿），
立即将"薪资期间 {{period}} 未确认 / 存在草稿，无法进行申报一致性核对"列为阻塞项排在结果最前；
不得转而读取草稿明细进行推算或估算。

【已确认时——与扣缴端申报表的对照清单】
仅当 confirmed 非空且 drafts 为空时，汇总：
- 申报人数：confirmed 列表员工数；
- 实发合计（元）：各条 netPay 之和；
- 当月个税合计（元）：各条 taxCurrent 之和；

产出以下两项核对清单：
① 申报人数对比（本系统人数 vs 申报表人数，差异须说明）；
② 当月个税合计对比（本系统 vs 申报表，差异须说明）；

明确声明：只用已确认期间的汇总数，不读工资明细；结论不拍板，只列核对项。
一切政策结论须标注「需核实当年政策」。`,
  },
  {
    id: "bank-recon",
    roleId: "treasury-officer",
    name: "银行对账",
    description: "对照银行流水文件与账面核对，逐笔列出差异",
    mode: "subagent",
    needsFiles: true,
    objectLabel: "银行账户",
    promptTemplate: `请对 {{period}} 期间做银行对账。

【文件分工】
若指派说明中指定了本次负责的账户流水文件，只处理该文件；否则处理用户提供的全部流水文件（多账户时按账户分列再合计，明细之和须等于合计）。

【解析前置步骤】
1. 先用 read_document 把银行流水文件读取并整理成结构化行，每行包含：
   - date（交易日期）
   - amount（金额，正数）
   - direction（方向，只能取 "in"（收入/进账）或 "out"（支出/出账）——这是 reconcile_bank_statement 要求的枚举口径，不得使用其他值）
   - description（摘要，可选）
   银行流水原始字段（如"收/付"、"借/贷"）到 "in"/"out" 的映射须在报告中显式声明。
2. 若有账面记录文件，解析其中属于本账户的记录（按 sheet 名或账户列筛选）；
   若账面文件中找不到本账户数据，将"无法在账面文件中定位本账户数据"列为阻塞项。
3. 两边数据就绪后，调用 reconcile_bank_statement 工具执行勾对。

【缺账面文件时的处理】
若用户未提供账面记录文件：
- 不得硬造勾对结论；
- 输出流水概况（笔数、收付合计、期间覆盖）；
- 将「缺账面记录，本期无法勾对」作为阻塞项排在报告最前。

【输出要求】
- 对不上的流水逐笔列出（日期、金额、摘要、可能原因），禁止静默跳过或模糊汇总；
- 多账户时按账户分列再合计，明细之和须等于合计，尾差须显式说明；
- 一切只读操作，不做付款、代拟付款指令或任何资金操作。`,
  },
  {
    id: "dunning-list",
    roleId: "receivables-officer",
    name: "催款清单",
    description: "按账龄分级生成催款清单草稿，账龄口径显式声明",
    mode: "subagent",
    objectLabel: "应收台账",
    promptTemplate: `请基于 {{period}} 期末应收台账生成催款清单草稿：
按账龄分级（30天以内 / 30-60天 / 60-90天 / 90天以上）列出各债务人名称、金额及最近联系情况（若有记录）；
账龄口径须在结果中显式声明（v1 口径：自约定回款日起算）；
催款函只出草稿，发送永远由人完成。`,
  },
];

// ─── 共享 helper（看板与 agent-card 复用） ───────────────────────────────────────

/**
 * 返回本地时区当前年月，格式 YYYY-MM。
 * 可注入 Date：API route 传已有的 now 保证同一响应口径一致。
 */
export function currentYearMonth(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * 按模板类型构造派活 href：
 * - main-skill → /chat/new?skill=<skillName>
 * - subagent   → /chat/new?prompt=让<roleName>执行「<name>」，期间 <period>[，稍后我会提供文件]
 *
 * 与 agent-card.tsx 原有逐字符一致，agent-card 改为 import 本函数复用。
 */
export function buildTemplateDispatchHref(t: TaskTemplate, roleName: string, period: string): string {
  if (t.mode === "main-skill" && t.skillName) {
    return `/chat/new?skill=${encodeURIComponent(t.skillName)}`;
  }
  return `/chat/new?prompt=${encodeURIComponent(
    `让${roleName}执行「${t.name}」，期间 ${period}${t.needsFiles ? "，稍后我会提供文件" : ""}`
  )}`;
}

/**
 * 按角色 id 取该角色的所有模板（不区分 mode）。
 */
export function getTemplatesForRole(roleId: string): TaskTemplate[] {
  return TASK_TEMPLATES.filter((t) => t.roleId === roleId);
}

/**
 * 按模板 id 查单个模板。
 */
export function getTaskTemplate(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((t) => t.id === id);
}

/**
 * 展开 subagent 型模板，返回最终 instructions 字符串。
 *
 * 校验：
 * - id 必须存在且 mode 为 "subagent"（main-skill 型不可展开）
 * - period 必须匹配 /^\d{4}-\d{2}$/
 *
 * 展开：将 {{period}} 替换为实际期间；若 extra 非空，末尾拼接「补充上下文：」段落。
 */
export function expandTaskTemplate(id: string, period: string, extra?: string): string {
  const template = TASK_TEMPLATES.find((t) => t.id === id);
  if (!template) {
    throw new Error(`未知模板 id "${id}"`);
  }
  if (template.mode !== "subagent") {
    throw new Error(
      `模板 "${id}" 的 mode 为 "${template.mode}"，expandTaskTemplate 只适用于 mode=subagent 的模板`
    );
  }
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error(`period 格式非法，须为 YYYY-MM，实际："${period}"`);
  }
  const expanded = template.promptTemplate!.replace(/\{\{period\}\}/g, period);
  if (extra && extra.trim()) {
    return `${expanded}\n\n补充上下文：${extra}`;
  }
  return expanded;
}
