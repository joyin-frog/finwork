# 财务事实库·第一刀（WP1a：终态 schema + 一步到位迁移 + store 门面切换）Spec

> 版本 v1.1 / 2026-07-06（v1.0 计划审查裁决 fix first，B1-B4/N1-N5 已修订，待限定范围复审）
> 状态：草案（§2 终态 schema 用户已批准 2026-07-06；schema 本身未变，修订均为计划文档层）
> 依赖：WP6 迁移纪律（已ship：baseline 冻结、rehearseMigrations 预演、删表不复活）
> 架构事实（2026-07-06 scout 摸底）：四个数据域现状——
> ① `invoice_ledger`（schema.ts:307-315）：仅 invoice_no PK/amount REAL/invoice_date/category/conversation_id/recorded_at，无方向/税率/税额/认证状态/对手方；写入 `recordInvoices`（finance-store.ts:343），读 `findInvoicesInLedger`:365 / `getInvoiceLedgerStats`:417。
> ② `payroll_records`（schema.ts:279-305）：金额全 REAL；唯一约束 (employee_name,year,month)；**已有信任标签雏形**——`status draft/confirmed` + `confirmed_at` + `tax_config_version` + `detail_json`；累计接力 `getLatestConfirmedPayroll`:239（仅年内），`getPriorConfirmedPeriod`:271（跨年基线）。
> ③ `business_metrics`（schema.ts:259-275）：唯一约束 (year,month)；`source`（migration v5 后为 'user_dictated'）；无状态/口径/精度保护。
> ④ 合同收付义务**无独立表**：存 `knowledge_documents.metadata`（JSON blob：status/amount/keyDates/counterparty/recurrence）+ `meta_status none/confirmed`，由纯函数 `deriveCashObligations`（lib/domain/cash-obligations.ts:65）动态派生，方向从 status 文本（"待付/待收"）推断。
> **关键杠杆**：所有读写都走 `lib/db/finance-store.ts` 门面（工具层/cockpit 不直接摸表）——迁移表结构 + 重写 store 内部，工具层调用方零改动。
> 精度现状：全库金额 REAL 浮点；唯一分整数先例是 finance_worker.py analyze_csv 内部累加（L27）。迁移框架：migrations.ts 当前 LATEST=6，新 DDL 一律追加迁移条目；`rehearseMigrations(db, dbPath)` 可在副本上预演。

## 0. 目标与非目标

**目标**：把四个数据域升维为带统一信任标签的事实层（决策 D3 一步到位）：新表落地 → 数据迁移（元 REAL→分 INTEGER，含精度校验）→ 旧表退役 → `finance-store.ts` 门面内部切换到新表，**对外 API 签名不变**（调用方零改动）。四标签（结算状态/口径版本/来源/精度）从 prompt 纪律变成 schema 物理约束。

**非目标（本期不做）**：
- 不动工具层/API route/cockpit 的任何调用代码（门面签名不变是本 spec 的核心承诺；义务落盘后 cockpit 的消费切换归 WP1b）；
- 不给 invoice 新字段接写入端（报销工具/凭证管线补写 direction/税率等归 WP1c；本期新列允许 NULL，存量迁移数据这些列就是 NULL）；
- 不做税率规则表（WP5a）；不做 provenance UI（WP4）；
- 不改 e2e/mock 数据形态。

## 1. 成功标准

- [ ] **迁移预演先行**：迁移在 `rehearseMigrations` 副本上跑通 + quick_check ok，才允许对真实库执行（实现为迁移函数的调用约定写进代码注释与测试）。
- [ ] **精度迁移零损耗**：元 REAL→分 INTEGER 用 `round(x*100)`，且每行校验 `|x*100 - round(x*100)| < 0.005`，超差的行**中止迁移并列出**（绝不静默吞，测试构造一条脏数据验证中止路径）。
- [ ] **删旧表不复活**：迁移完成后 `invoice_ledger`/`payroll_records`/`business_metrics` 不存在，重启后仍不存在（踩 WP6 的删表不复活保障，加对应断言）。
- [ ] **门面等价（修订，reviewer B1）**：`finance-store.ts` 全部导出函数签名与返回值形态不变（元为单位的 number）。验证分两类：① **门面消费型测试**（payroll-store/reimbursement-ledger/finance-summary/cockpit-*）不改断言直接跑绿；② **物理表断言型测试**（直接摸表名/直写 SQL 的四个文件，见 Files touched）允许且必须更新到新表名与新列，逐处在 audit 列出——它们测的是 schema 物理层而非门面，更新它们不构成门面破坏。除这四个文件外发现任何测试需要改断言 = 门面破坏 = 停下报告。
- [ ] 累计接力/确认状态机行为逐位保持：`getLatestConfirmedPayroll` 年内接力、`confirmPayrollPeriod` 锁定语义、(employee,year,month) 唯一性，专项测试覆盖。
- [ ] golden-schema.json 同步更新（WP6 机制），**顺序（reviewer B2）**：先更新 golden（移除三张旧表、加入四张 fact_* 新表），再跑 db-migration-discipline 的 T2 对照测试验证绿——golden 只增不减会让 T2 因旧表消失而红。
- [ ] TDD：先写迁移行为测试（红）再写迁移；全量 `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 绿。

## 2. 终态 schema（⚠️ 待用户过目）

**统一信任标签列约定**（四张事实表共有，命名与语义全库一致）：

| 列 | 类型 | 语义 |
|---|---|---|
| `settlement_status` | TEXT | 结算状态，域内枚举（见各表）；只进不退 |
| `caliber_version` | TEXT | 口径/规则版本标签（payroll 沿用 tax_config_version 的值域；其余表本期恒 'v1'，WP5 规则表落地后接真版本） |
| `source` | TEXT | `user_dictated` / `agent_derived` / `file_import` |
| `*_cents` | INTEGER | 一切金额为分整数；元只出现在 store 门面边界（读时 /100，写时 round(×100)+校验） |
| `provenance` | TEXT(JSON) | 来源指针（文件/单元格/发票号/公式），可 NULL，WP4 消费 |

**fact_invoices**（承接 invoice_ledger + 补 WP1 缺口字段，新列存量为 NULL；**完整列清单，reviewer B4——recorded_at/conversation_id 显式保留**，getInvoiceLedgerStats 的 `WHERE recorded_at LIKE ?` 统计依赖它）：
`invoice_no TEXT PK · direction TEXT('in'/'out') NULL · amount_cents INTEGER NOT NULL · tax_rate REAL NULL · tax_amount_cents INTEGER NULL · certification_status TEXT NULL('uncertified'/'certified'/'deducted') · counterparty TEXT NULL · invoice_date TEXT · category TEXT · settlement_status TEXT NOT NULL DEFAULT 'recorded'('recorded'/'filed') · caliber_version TEXT NOT NULL DEFAULT 'v1' · source TEXT NOT NULL（存量迁移置 'user_dictated'）· provenance TEXT NULL · conversation_id INTEGER NULL · recorded_at TEXT NOT NULL`

**fact_payroll**（承接 payroll_records，字段一一对应仅元→分）：
金额列 `gross_pay_cents / social_insurance_cents / housing_fund_cents / special_deduction_cents / net_pay_cents / tax_current_cents` + 年累计六列同法；`settlement_status`（承接 status：'draft'/'confirmed'）+ `confirmed_at`；`caliber_version`（承接 tax_config_version）；`source DEFAULT 'agent_derived'`；`detail_json` 保留；唯一约束 (employee_name,year,month) 不变。

**fact_metrics**（承接 business_metrics）：
`revenue_cents / cost_cents / expense_cents / profit_cents`；`settlement_status DEFAULT 'stated'`（'stated' 口述值/'closed' 结账值——为 WP2 环比可比性铺路）；`caliber_version DEFAULT 'v1'`；`source` 承接；唯一 (year,month) 不变。

**fact_obligations**（新表，义务首次落盘；本期只建表+迁移派生逻辑写入，消费切换归 WP1b）：
`id PK · direction TEXT('pay'/'receive') · amount_cents · due_date TEXT · counterparty TEXT · status TEXT('pending'/'settled') · recurrence TEXT NULL · source_document_id INTEGER（FK knowledge_documents，义务真相源仍是确认过的合同文档）· settlement_status DEFAULT 'derived'('derived'/'confirmed') · source DEFAULT 'agent_derived' · provenance · derived_at`
同步语义：文档 metadata 变更/meta_status 变更时重派生该文档的义务行（delete+insert，幂等）；`deriveCashObligations` 纯函数保留为派生器，结果落盘而非每次现算。

**设计取舍（已定，供评审推翻）**：① 否决单张 EAV 大宽表（financial_facts）——查询/约束/迁移全变差，四域字段差异大，统一的是"标签列约定"不是物理表；② 分整数列后缀 `_cents` 显式命名，杜绝单位歧义；③ direction/税率等新列允许 NULL 而非编造默认值（红线：不知道就是 NULL，A4/报表消费方必须处理 NULL=未登记）；④ 义务落盘但真相源仍是文档（source_document_id 外键 + 重派生），不搞双头真相。

## 3. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | 追加 v7 `facts_foundation`：建四张新表 → 数据搬迁（含分转换校验）→ DROP 三张旧表（invoice_ledger/payroll_records/business_metrics） |
| `lib/db/finance-store.ts` | 修改 | 内部 SQL 全部切新表；边界元⇄分转换——**转换点显式点名（reviewer B3）**：私有聚合函数 `buildRangeView`/`buildMonthView`（553-573 行区域，JS 端 reduce 聚合 revenue/profit）必须同步改列名并在门面出口 /100，`getInvoiceLedgerStats`（418-423）的 COUNT+`recorded_at LIKE` 切新表；导出签名零改动 |
| `lib/db/schema.ts` | 不动 | 已冻结（旧表定义留在 baseline 供 v0 新库先建后迁，v7 对新库同样执行——新库路径：baseline 建旧表(空) → v7 建新表+空迁移+删旧表） |
| `lib/domain/cash-obligations.ts` | 修改 | 派生函数增加落盘出口（供迁移与后续同步调用；现有动态消费路径本期不动） |
| `tests/db-facts-migration.test.ts` | 新增 | 迁移行为五组：预演先行/精度校验中止/旧表退役/门面等价抽样/接力保持 |
| `tests/fixtures/golden-schema.json` | 修改 | 同步新表结构（WP6 机制） |
| `tests/all.test.ts` | 修改 | 注册新测试（**吸取第一批教训，显式列出**） |
| `tests/data-safety.test.ts` | 修改 | CORE_TABLES 等表存在性断言：payroll_records → fact_payroll（reviewer B1） |
| `tests/small-utils.test.ts` | 修改 | 逐表存在断言更新到新表名（reviewer B1） |
| `tests/business-metrics-source.test.ts` | 修改 | 直写 SQL 更新到 fact_metrics 新表新列（含 *_cents 值语义，reviewer B1） |
| `tests/business-metrics.test.ts` | 修改 | 直查 SQL 更新到 fact_metrics（reviewer B1） |
| `tests/db-hardening.test.ts` | 修改 | 实施中发现的第五个物理表断言（46-48 行：备份含 payroll_records）→ fact_payroll。implementer 按纪律停下报告，orchestrator 2026-07-06 批准增补（同属物理表断言型一行事实更新） |

## 4. 测试与验证方式

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test          # 全量（含既有 payroll-store 等不改断言跑绿）
npm run typecheck && npm run lint
```

- 新增测试见 §3；既有测试是门面等价的主验证器，**禁止为迁移改动它们的断言**（要改=门面破坏=设计失败）。
- 不需要跑：e2e、golden eval。

## 5. 风险与开放问题

- **REAL→分的历史脏数据**：存量浮点若有 >0.005 元的表示误差，迁移中止并列出行——**中止 = 在 up() 内抛出异常**，由 runMigrations 事务 ROLLBACK 保证原库无损（reviewer N2 澄清），需要用户处置后重跑。rehearse 预演会提前暴露。
- **registry.ts dataScope 文档字符串**引用旧表名（37/60/82/140 行），文档性质不影响运行，**归 WP1c 随写入端一起更新**（reviewer N5）。
- **v0 新库路径**：baseline（冻结）先建旧表 → v7 立即建新表+删旧表，旧表短暂存在但无数据，无害；golden-schema 以 v7 后为准。
- **detail_json 里的元单位数字**：快照性质，不迁移改写（历史计算凭据保持原样），读取方（receipt 渲染）不受影响。
- 开放问题（不阻塞本 spec，记录给 WP1b/c）：义务重派生的触发点挂在哪（saveDocumentMeta 后钩子 vs cockpit 读时懒同步）——WP1b 定。
