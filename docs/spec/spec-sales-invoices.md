# 往来落地第二刀（WP13b：销项发票登记 + 发票级账龄 + 回款落盘）Spec

> 版本 v1.1 / 2026-07-07（v1.0 fix first：B1 账龄符号矛盾、B2 before-image 全列约束已修，N1-N4 采纳）
> 状态：**计划已批准**（限定复审通过，2026-07-07；实施须待 WP15 完整 ship 后启动，门控三条见依赖行）
> 依赖：WP13a（已ship）、WP1c（已ship）、**WP15 审计撤销（须完整 ship——本刀两个写工具接 recordAudit；开工门控三条（reviewer N4）：① migrations.ts 末条为 v12 audit_logs 补列；② lib/db/audit-store.ts 存在且导出 recordAudit；③ finance-store.ts 的 recordInvoices 已迁移到 recordAudit（无 auditLog 残留）。任一不满足停止报告。本刀迁移占 v13。**
> 架构事实（2026-07-07 scout + orchestrator 精读核实）：
> - fact_invoices 全列（migrations v7 :158-174 + WP1c 补列）：invoice_no/direction/amount_cents/tax_rate/tax_amount_cents/certification_status/counterparty/invoice_date/category/settlement_status(DEFAULT 'recorded')/caliber_version/source/provenance/conversation_id/recorded_at。**direction='out' 销项行当前无任何写入方**——record_reimbursement_invoices 硬写 direction:"in"（lib/agent/tools/finance/reimbursement.ts:133），底层 recordInvoices 支持任意 direction。
> - settlement_status 列存在但**从未被更新**（无 settled 写路径）；无 settled_at/回款金额列；无独立 payments 表先例。
> - 应收现状：listReceivablesRaw（finance-store.ts:789）查 fact_obligations kind='receive'，**合同义务层**口径；agingDays=due_date−asOf 由 store 返回原始值、分箱在 receivables-ledger/SKILL.md:37（agent 层）。发票层与合同层无关联字段。
> - 写工具先例：record_reimbursement_invoices（reimbursement.ts:66-152）——zod items[]、税率 0<rate<1 校验、税额元→分精度守卫（±0.005）、recordInvoices 返回 {inserted,duplicates} 且重复发票显式报告、riskLevel medium。已接 recordAudit 留痕（WP15，若其实施如期）。
> - 读工具先例：query_invoice_ledger / query_receivables 均 safe（registry.ts:50,52）。
> - 哨兵：tests/invoice-write-path.test.ts（T1 全字段/T2 零新字段/T3 非法税率/T4 breakdown）、tests/receivables-live.test.ts（RL-1~6 含 structuredContent 形状断言——**不动 query_receivables 的返回形状**）、tool-registry T2（真实注册）/T6（renderer 摘要强制）、golden-schema、all.test.ts 手动注册。
> - 基线注意：近期提交 8398c49 动过发票台账按月口径与义务落盘事务化，以现状代码为准。

## 0. 目标与非目标

**目标**：应收从"合同义务层"下沉到"发票层"闭环：① v13 fact_invoices 补回款三列；② `record_sales_invoices` 写工具（销项登记，direction='out'）；③ `record_invoice_settlement` 写工具（回款落盘：settlement_status→'settled' + 实收金额/日期/备注）；④ `query_sales_invoices` 读工具（销项清单 + 发票级账龄分箱 + 回款状态）；⑤ receivables-ledger 技能升级为两层口径（合同义务层 + 销项发票层并列呈现）。两个写工具均接 WP15 recordAudit（登记可撤销=delete_rows；回款可撤销=restore_rows before-image）。

**非目标**：合同义务（fact_obligations kind='receive'）与销项发票的自动勾稽/关联（两层并列各自呈现，勾稽需要单据关联模型，另一刀）；分期/部分核销（v1 回款=单次结清登记，settled_amount_cents 记实收金额可与发票额不同，**此为业务口径假设**——若用户日后要分期需引入 payments 表）；进项发票的付款侧（本刀只做应收/销项）；开票申请流程；query_receivables 返回形状改动（RL 哨兵盯形状）。

## 1. 成功标准（先红后绿）

- [ ] **v13 fact_invoices 补列**：`settled_at TEXT NULL · settled_amount_cents INTEGER NULL · settlement_note TEXT NULL`；golden-schema 同步。既有行为哨兵（invoice-write-path T1-T4）零改动跑绿。
- [ ] **`record_sales_invoices`**（finance/medium，接线三件套 TOOL_REGISTRY+renderers T6+主对话与 receivables-officer 角色可用——对齐 WP13a 角色工具白名单现状，开工核实 registry 的角色 tools 列表）：zod 与精度守卫镜像 reimbursement 先例（invoiceNo/amount/invoiceDate/category/taxRate/taxAmountYuan/counterparty=客户名），handler 调 recordInvoices 传 `direction:'out'`；duplicates 显式报告；接 recordAudit（eventType `sales_invoice_record`，undo=delete_rows 仅 inserted 键，conversationId 透传）。
- [ ] **`record_invoice_settlement`**（finance/medium，进 receivables-officer 白名单）：入参 invoiceNo + settledAmountYuan（必填，元→分精度守卫）+ settledAt?（缺省当日）+ note?；校验发票存在且 direction='out' 且未 settled（已 settled 拒绝并回显首次回款信息；进项发票拒绝并提示工具用途）；新 store 函数 `settleInvoice`（finance-store.ts，元⇄分边界惯例），**执行顺序硬约束（reviewer B2）：先 `SELECT *` 捕获全列 before-image（必须含 v13 新三列，此时均 NULL）→ UPDATE settlement_status='settled' + 三列 → recordAudit（eventType `invoice_settlement`，undo=restore_rows 该 before-image）**——保证撤销后 settled_at/settled_amount_cents/settlement_note 三列回 NULL、status 回 'recorded'。
- [ ] **`query_sales_invoices`**（finance/safe，进 receivables-officer 白名单）：新 store 函数 `listSalesInvoices({asOf?, includeSettled?})`——direction='out' 全列 + `agingDays = asOf − invoice_date`（**正值=已开票 N 天；符号约定与合同层 SKILL 的 `due_date − asOf`（正=未到期）刻意相反，两层语义不同不得共享分箱逻辑——reviewer B1**；仅未 settled 行计算；invoice_date NULL 行 agingDays=null 且显式标注）；工具层输出发票层专属分箱：**已开票 0-30 / 31-60 / 61-90 / 90+ 天**；structuredContent 新形状（不复用 query_receivables 的）。
- [ ] **SKILL 升级**：receivables-ledger/SKILL.md 增"发票层"步骤——query_sales_invoices 查销项账龄、高账龄项进催款清单（与合同层清单并列）、收到回款时指引调 record_invoice_settlement；**必须包含与合同层平行格式的发票层分箱边界表（已开票 0-30/31-60/61-90/90+ 天）并显式声明两层账龄符号约定相反（reviewer B1）**；补跨方向重复指引：系统报"重复发票号"但实为不同业务发票时人工排查（invoice_no 是全局主键，reviewer N2）；既有四步与三条声明保留。
- [ ] 测试（tests/sales-invoices.test.ts）：迁移形状/销项写入（direction='out' 落库+审计行含 undo）/回款（settled 三列落值+**撤销后 settled_at、settled_amount_cents、settlement_note 三列均断言为 NULL 且 status='recorded'（reviewer B2）**）/重复回款拒绝/进项发票拒绝/账龄计算（正值语义、invoice_date NULL、settled 排除）/query 工具 structuredContent 形状；注册 all.test.ts 末尾；tool-registry T2 追加两写一读三个工具名（与角色白名单三工具一致，reviewer N3）。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint（警告数不增）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v13 fact_invoices 补三列 |
| `lib/db/finance-store.ts` | 修改 | settleInvoice + listSalesInvoices |
| `lib/agent/tools/finance/sales-invoices.ts` | 新增 | 三工具定义（镜像 reimbursement.ts 文件组织） |
| `lib/agent/mcp-tools/index.ts` | 修改 | 挂载（reimbursement.ts 同款模式：tools/finance/ 下定义、index.ts spread 引入——reviewer N1 核实两种组装模式并存，本刀跟 reimbursement 先例） |
| `lib/agent/tools/registry.ts` | 修改 | 三工具注册 |
| `lib/agent/tools/renderers.ts` | 修改 | 中文摘要 ×3（T6） |
| `lib/agent/roles/registry.ts` | 修改 | receivables-officer 白名单补三工具（开工核实白名单机制） |
| `agent-skills/skills/receivables-ledger/SKILL.md` | 修改 | 发票层步骤 |
| `tests/sales-invoices.test.ts` | 新增 | §1 全部行为 |
| `tests/tool-registry.test.ts` | 修改 | T2 清单追加 |
| `tests/fixtures/golden-schema.json` | 修改 | v13 同步 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试（迁移形状/账龄/回款撤销）。2. v13+golden。3. store 两函数。4. 三工具+接线（T2/T6）。5. 角色白名单。6. SKILL。7. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **业务口径假设（需用户后续确认，已选保守默认）**：回款=单次结清（不支持分期）；实收金额可与发票额不同但不做差额科目处理（只记录）；账龄自 invoice_date 起算（非合同 due_date——发票层与合同层口径天然不同，SKILL 分节声明）。
- record_sales_invoices 与 record_reimbursement_invoices 共用 recordInvoices 底层，INSERT OR IGNORE 幂等语义与 duplicates 报告继承——同一发票号不可能既是进项又是销项（invoice_no 主键），跨方向重复会被报 duplicate，SKILL 提示核实。
- 被否决：① 独立 payments 表（无分期需求证据，加列与既有 payroll confirmed_at 模式一致；分期需求出现时再迁移）；② 扩展 record_reimbursement_invoices 加 direction 参数（提示词语义全是报销/进项，混用致误导；项目惯例场景分工具）；③ 并入 query_receivables 返回（RL 哨兵盯形状，两层口径混一个 structuredContent 徒增歧义）；④ 合同-发票自动勾稽（需单据关联模型，证据不足）。
