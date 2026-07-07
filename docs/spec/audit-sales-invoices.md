# Audit: WP13b 销项发票登记 + 发票级账龄 + 回款落盘

> Implementer: claude-sonnet-4-6 / 2026-07-07

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/db/migrations.ts` | 修改 — 追加 v13 迁移，fact_invoices 补三列（settled_at / settled_amount_cents / settlement_note），含防御性 CREATE TABLE IF NOT EXISTS |
| `lib/db/finance-store.ts` | 修改 — 追加 settleInvoice + listSalesInvoices 两函数 |
| `lib/agent/tools/finance/sales-invoices.ts` | 新增 — createSalesInvoiceTools（record_sales_invoices / record_invoice_settlement / query_sales_invoices） |
| `lib/agent/mcp-tools/index.ts` | 修改 — import createSalesInvoiceTools，spread 进 tools 数组 |
| `lib/agent/tools/registry.ts` | 修改 — 三工具注册（medium/medium/safe） |
| `lib/agent/tools/renderers.ts` | 修改 — 三工具中文摘要（T6） |
| `lib/agent/roles/registry.ts` | 修改 — receivables-officer tools 白名单补三工具 |
| `agent-skills/skills/receivables-ledger/SKILL.md` | 修改 — 补发票层步骤、两层账龄符号对照表、重复发票号指引 |
| `tests/sales-invoices.test.ts` | 新增 — SI-1~11 全行为覆盖 |
| `tests/tool-registry.test.ts` | 修改 — T2 清单追加三工具 |
| `tests/fixtures/golden-schema.json` | 修改 — fact_invoices 补三列（cid 15/16/17） |
| `tests/all.test.ts` | 修改 — 末尾追加 salesInvoicesTestPromise |

---

## §1 成功标准逐条核对

### v13 fact_invoices 补列

- **红态证据**：SI-1 在无迁移时直接失败于 `settled_at 列不存在`（AssertionError: SI-1 FAIL: fact_invoices 缺 settled_at 列）
- **绿态**：v13 迁移追加三列，SI-1 通过（三列均存在且 notnull=0）
- **既有哨兵不受影响**：invoice-write-path T1-T4、receivables-live RL-1~6 全部通过（见全量输出）
- **golden-schema 同步**：fact_invoices 增 cid 15/16/17 三条记录

### record_sales_invoices

- direction='out' 落库：SI-2 断言 `row.direction === 'out'`，通过
- settlement_status 初始 'recorded'：SI-2 断言通过
- 审计行含 undo（delete_rows 仅 inserted 键）：SI-2 查 audit_logs 断言 undo 存在且 keys 含 OUT-SI-001，通过
- duplicates 显式报告：SI-2 测试中重复路径逻辑与 reimbursement 先例相同（recordInvoices 底层一致）
- taxRate 校验：复用 reimbursement 先例精度守卫逻辑
- receivables-officer 白名单：roles/registry.ts tools 数组已含 record_sales_invoices，role-registry 测试（resolveRoleAllowedTools）通过
- T6 renderer：record_sales_invoices 中文摘要已注册，tool-registry T6 通过

### record_invoice_settlement

- 发票存在且 direction='out' 且未 settled：SI-3 三列落值断言全部通过
- **B2 执行顺序硬约束**：settleInvoice 先 SELECT *（全列 before-image），再 UPDATE，再 recordAudit（undo=restore_rows）
- **B2 before-image 全列验证**：SI-3 断言 before-image 含 settled_at/settled_amount_cents/settlement_note 三列且均为 NULL，通过
- 已 settled 拒绝并回显首次信息：SI-5 通过（alreadySettled: true）
- 进项发票拒绝：SI-6 通过（wrongDirection: true）
- 不存在拒绝：SI-7 通过（notFound: true）
- receivables-officer 白名单 + T6 renderer：已注册，测试通过

### record_invoice_settlement 撤销后三列回 NULL（B2 核心约束）

- **SI-4 直接断言**：undoAuditEntry 后，settled_at/settled_amount_cents/settlement_note 均为 NULL，settlement_status 回 'recorded'
- 输出：`sales-invoices: all 11 checks passed ✓`

### query_sales_invoices

- direction='out' 全列 + agingDays = asOf − invoice_date（正值）：SI-8 agingDays=36，通过
- **B1 符号约定**：正值=已开票天数（asOf - invoice_date），与合同层（due_date - asOf，正=未到期）方向相反；代码注释、SKILL.md 分节声明均已标注
- invoice_date NULL 行 agingDays=null：SI-9 通过
- settled 行排除（includeSettled=false）：SI-10 通过
- settled 行 agingDays=null：SI-10 通过
- structuredContent 新形状（items/agingSummary/totalCount）：SI-11 通过，四桶（bucket0_30/31_60/61_90/90plus）全部存在
- 不复用 query_receivables 形状：独立 structuredContent，RL 哨兵形状不受影响

### SKILL 升级

- 发票层步骤（第五～七步）：已添加至 receivables-ledger/SKILL.md
- 两层账龄分箱边界表（已开票 0-30/31-60/61-90/90+ 天）：已添加
- 两层符号约定相反声明（B1）：header 对照表已明确标注，第四步声明已更新
- 重复发票号跨方向排查指引（N2）：已添加"重复发票号跨方向说明"节
- 既有四步与三条声明保留：已保留，仅扩展第四步声明

### 测试注册

- all.test.ts 末尾追加 salesInvoicesTestPromise：已添加
- tool-registry T2 追加三工具名：已追加 record_sales_invoices / record_invoice_settlement / query_sales_invoices

### 全量 EXIT=0 零 unhandledRejection + typecheck + lint

```
FINANCE_AGENT_PYTHON_PATH=... FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
# pass 11 / fail 0 / cancelled 0
# EXIT=0（无 unhandledRejection）

npm run typecheck → 零错误
npm run lint → 141 problems (0 errors, 141 warnings)（与基线 141 持平，零增）
```

---

## 偏差与原因

1. **v13 迁移加防御性 CREATE TABLE IF NOT EXISTS fact_invoices**：基线不含此防御，但 v12 的 audit_logs 迁移有同款模式。原因：policy-rules.test.ts 中某些测试直接设置 user_version 绕过 initializeSchema，导致 fact_invoices 不存在时 addColumnIfMissing 的 ALTER TABLE 抛错（unhandledRejection）。加此防御后无新 warning 且与既有模式一致，符合"手术式修改对应 spec 条目"原则——spec §4 风险第二条提到"与既有 payroll confirmed_at 模式一致"，防御模式即该惯例的延伸。

2. **roles/registry.ts receivables-officer rolePrompt 未更新**：spec §2 Files touched 说明 roles/registry.ts 只需"receivables-officer 白名单补三工具"，并未要求更新 rolePrompt 文字。rolePrompt 中"开票日口径待销项数据落地后提供"一句已属陈旧，但不在 spec 改动范围内，未触碰。（fix-first 轮 N3 已修正此文案。）

---

## 修复轮（fix first 裁决后）

### B1（阻塞）：审计轨迹归因错误

**问题**：recordInvoices 硬编码 `eventType:"invoice_ledger_record"` + `toolName:"record_reimbursement_invoices"`，sales-invoices 走它时销项写入被记成报销工具，审计轨迹误导。

**红态证据**：SI-2 断言 `event_type='sales_invoice_record'` → `AssertionError: SI-2 FAIL: 应有 event_type='sales_invoice_record' 的审计行（不能错记成 invoice_ledger_record）`（actual: undefined）

**修法**：
- `lib/db/finance-store.ts`：recordInvoices 加可选第三参数 `auditHint?: RecordInvoicesAuditHint`（含 eventType / toolName），缺省保持报销路径原值（零副作用）
- `lib/agent/tools/finance/sales-invoices.ts`：调用时传 `{ eventType:'sales_invoice_record', toolName:'record_sales_invoices' }`
- `tests/sales-invoices.test.ts`：SI-2 改为用 auditHint 调 recordInvoices，断言 event_type='sales_invoice_record'；新增防回归断言（报销路径无 hint 仍为 invoice_ledger_record）

### N1（非阻塞采纳）：conversationId 透传到 settleInvoice

**问题**：record_invoice_settlement zod schema 有 conversationId 但 settleInvoice 调用时静默丢弃，审计行 conversation_id=null。

**修法**：
- `lib/db/finance-store.ts`：SettleInvoiceInput 加可选 `conversationId?: number | null`，透传给 recordAudit 的 conversationId 字段
- `lib/agent/tools/finance/sales-invoices.ts`：settleInvoice 调用时传 `conversationId: args.conversationId`
- `tests/sales-invoices.test.ts`：SI-3 settleInvoice 调用传 `conversationId: 77`，新增断言验证 audit 行 conversation_id=77

### N2（非阻塞采纳）：eslint-disable-next-line 产生 unused-disable 警告

**问题**：`no-explicit-any` 规则全局 `"off"`，disable 注释在 type alias 行上永远"unused"，产生 +1 警告。

**修法**：sales-invoices.ts 移除 eslint-disable 注释（`any` 在 type alias 中本身不触发任何规则）。lint 警告从 141 降至 140。

### N3（非阻塞采纳）：rolePrompt 过时文案

**修法**：roles/registry.ts receivables-officer rolePrompt 第 133 行改为指引使用 query_sales_invoices 工具获取开票日账龄。

### 修复轮验证结果

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test → EXIT=0，pass 11 / fail 0，零 unhandledRejection
npm run typecheck → 零错误
npm run lint → 140 problems (0 errors, 140 warnings)（达到目标 140）
```

---

## 开放风险

- 业务口径假设（spec §5 标注）：回款=单次结清；实收金额可与发票额不同；账龄自 invoice_date 起算。均已在 SKILL.md 和 query_sales_invoices 工具描述中显式声明，待用户后续确认。
- settleInvoice 精度守卫（yuanToCents）与 reimbursement 路径一致；超差时抛错由 try/catch 捕获返回 isError。
- 无撤销的 record_sales_invoices 伪重复场景（跨方向同号）：SKILL.md 已加排查指引，底层 INSERT OR IGNORE 幂等语义与 duplicates 报告继承自既有路径，无改动。
