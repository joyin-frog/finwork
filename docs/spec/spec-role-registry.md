# 角色注册表与子代理角色化 Spec

> 版本 v1.0 / 2026-07-02
> 依赖：`lib/agent/subagent-runner.ts`（现状 runner）、`lib/agent/mcp-tools/subagent.ts`（spawn_subagent）、`lib/agent/tools/registry.ts`（TOOL_REGISTRY / ALLOWED_TOOLS）、`lib/agent/skills-store.ts`（技能白名单机制）、`lib/db/migrations.ts`（版本化迁移）
> 架构事实：子代理 = 独立 `sdk.query()`，无人机确认通道（`resolveUserQuestion: undefined`），高风险工具经 `createRiskConfirmHook` fail-closed 拒绝；`persistSession: false`；并发 5；SQLite 走 `node:sqlite`

---

## 0. 目标与非目标

**目标**：把子代理从「按技能派发的扁平枚举」升级为「按财务职能域预制的角色」，一次解决四个问题：

1. **越域权限洞**：现状子代理拿工具全集（`subagent-runner.ts:59` 的 `ALLOWED_TOOLS`），风险门只按 high 拦，不按域拦——报销任务的子代理今天可以调 `query_payroll_status`（safe 级直接放行）。角色化后权限隔离从「按风险」升级为「按风险 × 按域」。
2. **system prompt 太薄**：现状五行通用文本（`buildSubagentSystemPrompt`），无职责边界、无负面清单、无域外拒答。
3. **无调度史**：派发结果只以工具结果文本回流主对话，无落表——总览页「角色卡随调度史生长」无数据可查。
4. **枚举与技能目录漂移**：`spawn_subagent` 枚举里的 `excel-finance` 在 `agent-skills/skills/` 下不存在，本次一并清理。

**非目标（明确不做）**：

- 不做运行时动态生成角色（可审计性、权限隔离、领域成熟三条硬性理由，见产品讨论记录）。
- 不做角色对角色（A2A）通信——协作发生在数据层（台账、状态机），不发生在聊天层。
- 不做常驻/后台 agent——巡检是「定时的一次派发」，走同一 runner。
- 不给子代理人机确认通道——「高风险必须回到主对话的人面前」是产品性质，不是缺陷。
- 不动主对话形态与现有 hook 链结构。
- 不设预算、成本角色（客群行业条件不满足，缓）。

---

## 1. 设计总则

1. **大类 = 角色 = 权限域**。角色边界对齐财务职能大类（核算 / 薪酬 / 税务 / 资金 / 往来 / 管理会计），不对齐现有技能清单。大类稳定，作业会增删。
2. **作业 = 技能**。技能作为可组合能力挂在角色下（`role.skills`），新增一个作业不动角色版图。
3. **内控与知识库不设角色**。内控已以架构存在（确认门 + `audit_logs` + 红线体系）；知识库是所有角色共享的读工具。
4. **角色定位三件套**：说明书（`rolePrompt`）+ 钥匙串（`tools`/`skills` 白名单）+ 交付契约（`deliverables`）。prompt 负责「知道自己是谁」，白名单负责「做不了分外事」——两层独立，缺一不可。
5. **白名单管域，风险门管险**。角色白名单里可以含高风险工具（表达「这个域的活归它」），但子代理内高风险仍被确认门 fail-closed 拒绝——两层判断互不替代。`confirm_payroll_period` 例外：**不进任何角色白名单**，期间确认永远发生在主对话、由人点。

---

## 2. 角色注册表

新建 `lib/agent/roles/registry.ts`，模式仿 `TOOL_REGISTRY`：TS const、进版本库、人工评审。

### 2.1 类型

```ts
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
};

// 所有角色共享的底座工具（现状内置文件/检索工具照旧放行，不在此列）
export const SHARED_TOOLS = [
  "run_python", "search_knowledge", "query_knowledge", "read_file", "finalize_deliverable",
];
```

### 2.2 六个角色条目（完整定义）

```ts
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
      "record_document_metadata", "query_kingdee_accounts", "validate_kingdee_voucher",
      "export_kingdee_draft",   // high：子代理内被确认门拒，白名单表达域归属
    ],
    dataScope: ["documents", "invoice_ledger", "金蝶科目表", "报销制度文件"],
    deliverables: ["voucher_draft", "risk_list", "ledger_entries"],
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
      "query_payroll_status", "tax_calculator",
    ],
    dataScope: ["payroll_records（全产品唯一有工资明细权限的角色）", "税率配置"],
    deliverables: ["payroll_draft", "calc_receipt", "diff_list"],
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
    skills: ["tax-incentive", "rnd-deduction-check", "xlsx"],  // 待建：filing-precheck
    tools: ["tax_calculator", "query_payroll_status"],
    dataScope: ["invoice_ledger（读）", "company_profile（读）", "薪资状态汇总（非明细）", "知识库政策文件"],
    deliverables: ["risk_list", "checklist"],
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
    available: false,   // 台账数据域未建，注册表预留；作业落地后翻 true
    skills: ["xlsx"],   // 待建：receivables-ledger（应收台账与账龄）
    tools: [],
    dataScope: ["待建：应收台账表", "documents 合同收付义务（读）"],
    deliverables: ["aging_report", "dunning_list"],
    rolePrompt: `你是往来专员，负责往来管理域：应收应付台账、账龄分析、
催款清单、与客户/供应商的对账单核对。
边界（违反即任务失败）：
- 催款函、对账函只出草稿，发送永远由人完成；
- 账龄口径（从开票日还是约定回款日起算）在结果中显式声明；
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
    tools: ["record_business_metrics", "generate_business_analysis"],
    dataScope: ["business_metrics", "用户上传的报表/费用/工资汇总文件"],
    deliverables: ["analysis_report", "metric_table"],
    rolePrompt: `你是经营分析师，负责管理会计域：经营数据分析、费用拆解、
财务比率、环比同比与趋势解读。
边界（违反即任务失败）：
- 你的所有结论属于「推测」层，输出必须可被标注为分析结论，不得写成事实断言；
- 任何跨期对比先检查两端口径与结算状态是否一致：草稿期数据不与已结账期并列比较，
  口径变了先说口径，再说业务；
- 环比异动的解释顺序固定：口径动没动 → 数据全不全 → 业务动没动；
- 分析产生的数字不回写为经营事实（record_business_metrics 只登记用户报的数，不登记你算的数）。
接到管理会计域之外的任务，返回 out_of_scope 并说明该由哪个域处理。`,
  },
];
```

### 2.3 与现状枚举的映射（一次性切换）

| 现枚举值 | 去向 |
|---|---|
| `reimbursement-check` | `bookkeeper` 的技能 |
| `kingdee-draft` | `bookkeeper` 的技能 |
| `payroll-calc` | `payroll-officer` 的技能 |
| `finance-analysis` | `analyst` 的技能 |
| `excel-finance` | **删除**（技能目录中不存在，用 `xlsx` / `finance-analysis` 覆盖） |

---

## 3. 子代理 system prompt：三段组装

`buildSubagentSystemPrompt(skillId)` 改为 `buildSubagentSystemPrompt(role: RoleDefinition)`，输出 = A 段基座 + B 段角色定位（`role.rolePrompt`）。C 段任务上下文走现有 `task.instructions + files`，不变。

### A 段·共享基座（全文，所有角色一份）

```
你是财务工作台的角色子代理，由主 Agent 派发执行单一任务。

【执行纪律】
- 你没有与用户对话的通道：不要提问、不要等待确认，基于给定信息尽力完成；
  信息不足时在结果中列出「缺什么、为什么需要」。
- 只做角色职责内的任务。任务超出角色边界时不要尝试完成，直接返回一行：
  out_of_scope: <一句话说明该由哪个域处理>。
- 执行域内专业作业时，先用 Skill 工具加载对应技能并遵循其流程。
- 部分高风险工具会被系统拒绝，这是设计而非故障：把已完成的准备工作
  与「待人确认的下一步」写进结果返回。

【财务纪律】
- 金额、税率、比率一律经工具计算，禁止心算；金额以分或 Decimal 处理。
- 查不到的数据明确说「没有查到」，禁止用近似值填空。
- 输出的每个关键数字带三样：来源（文件/表/发票号）、口径或期间、
  结算状态（草稿/已确认）。
- 身份证号、银行卡号不写入结果正文；需要引用时用掩码。

【交付契约】
- 回复第一段固定为【结果摘要】：关键数字 + 结论 + 异常计数。
- 异常与疑点按风险从高到低排列，每条给出定位与建议动作。
- 产出文件用 finalize_deliverable 声明。
```

---

## 4. spawn_subagent 与 runSubagent 改造

### 4.1 `spawn_subagent`（`lib/agent/mcp-tools/subagent.ts`）

- 参数 `skill: z.enum([...5 个技能])` → `role: z.enum(ROLE_REGISTRY.filter(r => r.available).map(r => r.id))`——枚举从注册表生成，不再手写。
- 工具 description 追加一段角色速查（id + charter，从注册表生成），替代主 Agent 靠猜。

### 4.2 `runSubagent`（`lib/agent/subagent-runner.ts`）

| 现状 | 改为 |
|---|---|
| `SubagentTask.skill: string` | `SubagentTask.roleId: string`（查注册表，查不到即失败返回） |
| `allowedTools = ALLOWED_TOOLS`（全集） | `allowedTools = 内置工具 ∪ SHARED_TOOLS ∪ (role.tools ∩ ALLOWED_TOOLS)` |
| `skills: [task.skill]` | `skills: role.skills`（沿用 `getSkillSdkConfig` 白名单机制） |
| `buildSubagentSystemPrompt(skillId)` 五行通用文本 | A 段基座 + `role.rolePrompt` |
| 无调度史 | 起止写 `subagent_dispatches`（§5） |

hook 链、`persistSession: false`、`maxTurns: 15`、180s 超时、并发 5、fail-closed 行为全部**不变**。

---

## 5. subagent_dispatches 表

`lib/db/migrations.ts` 追加一条迁移（版本号取当时最新 +1）：

```sql
CREATE TABLE IF NOT EXISTS subagent_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id TEXT NOT NULL,
  skill TEXT,                        -- 实际派发时主用的技能（可空）
  label TEXT,
  trace_id TEXT,                     -- 贯通现有观测体系（agent_traces / audit_logs）
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',   -- running | success | failed
  summary TEXT,                      -- 结果摘要首行，截断存储
  blocked_reason TEXT,               -- 非空 = 途中撞确认门被拒的工具名（可多个，逗号分隔）
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dispatches_role_time
  ON subagent_dispatches(role_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatches_blocked
  ON subagent_dispatches(blocked_reason) WHERE blocked_reason IS NOT NULL;
```

写入时机：

- `runSubagent` 入口 INSERT（`running`）；结束 UPDATE（`success`/`failed` + summary + duration）。
- `createRiskConfirmHook` 在子代理上下文中返回 deny 时，由 runner 的 `canUseTool` 回调捕获并累加 `blocked_reason`。**status 与 blocked_reason 独立**：任务可以 success 且带 blocked_reason（干完了安全部分、高风险部分待人）。

### 5.1 下游消费（本 spec 只定查询契约，UI 另起 spec）

- 角色卡可见性：`SELECT role_id, COUNT(*), MAX(ended_at) FROM subagent_dispatches GROUP BY role_id` —— 有记录才渲染。
- 关注区供给源之一：`WHERE blocked_reason IS NOT NULL AND ended_at > :recent` —— 「停在门前的活」。

---

## 6. 作业缺口清单（挂角色的 roadmap，非本 spec 实现范围）

| 优先 | 作业（待建技能） | 角色 | 日历节点 | 备注 |
|---|---|---|---|---|
| P0 | `filing-precheck` 申报前复核清单 | tax-officer | 1–15 报税期 | 增值税+附加勾稽、进项齐套、个税申报数与 confirmed 薪资一致性；数据大半现成 |
| P0 | 单据→凭证批量草稿 | bookkeeper | 月末 | 已立项（voucher-from-slips） |
| P1 | 结账前检查清单 | bookkeeper | 25 日–月末 | 工资计提 vs confirmed、折旧摊销提醒、费用票齐套率 |
| P1 | 个税扣缴申报数据导出 | payroll-officer | 报税期 | confirmed payroll → 扣缴端导入格式 |
| P1 | `cash-daily` 资金日报 | treasury-officer | 每日 | 吃网银导出流水，文件进文件出 |
| P1 | `receivables-ledger` 应收台账+账龄+催款清单 | receivables-officer | 月中 | 需新建台账数据域；落地后该角色 `available` 翻 true |
| P2 | 对账单核对 / 余额调节表 / 口径沉淀 / 社保基数提醒 | 往来/资金/分析/薪税 | 分散 | 改善型 |
| 不做 | 预算、成本核算、报表生成、工资条分发 | — | — | 客群不匹配 / 账本在金蝶 / 敏感通道未解决 |

---

## 7. 红线对齐

| 红线 | 本 spec 的落点 |
|---|---|
| 2 数值正确性 | A 段「禁止心算」+ 各角色确定性工具白名单 |
| 3 数据信任链 | A 段「关键数字带来源/口径/状态」；analyst 禁止草稿期与已结账期并列 |
| 5 写操作审批 | 高风险工具子代理内 fail-closed 不变；`confirm_payroll_period` 不进任何角色白名单 |
| 6 决策边界 | tax-officer / analyst rolePrompt 的「只给依据不拍板」条款 |
| 7 合规驻留 | A 段掩码条款；payroll-officer 是唯一有工资明细权限的角色，tax-officer 显式只拿汇总 |
| 8 审计落点 | dispatches 表 + trace_id 贯通；工具审计走现有 `withIdempotency` 不变 |

---

## 8. 验收标准

1. **越域拒绝**：以 `bookkeeper` 派发的子代理调用 `query_payroll_status` → 不在 allowedTools，被拒。
2. **域外拒答**：给 `tax-officer` 派「算 6 月工资」→ 返回以 `out_of_scope:` 开头（mockSdk 场景测试）。
3. **fail-closed 不回归**：子代理内调 `export_kingdee_draft` → deny，且 `blocked_reason` 落表。
4. **调度史生命周期**：派发 INSERT `running` → 结束 UPDATE `success/failed`，`ended_at`/`duration_ms` 非空。
5. **注册表静态守卫**（学 `tests/safety-redaction.test.ts` 的静态检查模式）：
   - 每个 `role.tools` ⊆ `TOOL_REGISTRY` 名字集；
   - 每个 `role.skills` 均存在于技能目录；
   - `confirm_payroll_period` 不出现在任何角色的 `tools` 里；
   - `spawn_subagent` 的 role 枚举 === 注册表 `available: true` 的 id 集。
6. **迁移幂等**：老库升级跑迁移两次不报错，`user_version` 正确推进。

---

## 9. 实施顺序

1. **Phase 1 — 注册表与 runner**：`lib/agent/roles/registry.ts` + `runSubagent` 改造 + `spawn_subagent` 参数切换 + A/B 段 prompt + 静态守卫测试。功能等价可回滚（角色→技能映射覆盖现有五个枚举值的全部能力）。
2. **Phase 2 — 调度史**：迁移新增 `subagent_dispatches` + runner 写入 + `blocked_reason` 捕获 + 查询函数（`listRoleDispatchSummary` / `listBlockedDispatches`）。
3. **Phase 3 — 消费端**：总览页角色卡与关注区接线，**另起 UI spec**，不在本 spec 范围。
