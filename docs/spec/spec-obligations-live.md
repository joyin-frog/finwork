# 义务落盘消费切换（WP1b：fact_obligations 重建 + 写钩子 + 读切换）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审仅剩 §5/§1 矛盾一条，orchestrator 修复与复审赛跑已消除，按"修复即批准"条款生效）
> 状态：**已实施并通过审查（ship）**。前任 implementer 连接中断、收尾者补全；实施审查 fix first（V6/V7 钩子测试假绿）→修复轮（真实调用 deleteDocument 与 PATCH handler+红态自证）→限定复审 ship。非阻塞记录：deleteTextMirror 双调用（既有低效非本刀引入）、done 注释过时、v9 守卫静默 return、reset 清行无自动化覆盖（audit 如实说明）。
> 依赖：WP1a（已ship）。迁移版本 v9（当前 LATEST=8）。
> 架构事实（2026-07-07 scout 核实）：`persistDerivedObligations`（cash-obligations.ts:131-166）已在但**零调用方**；`fact_obligations` 表**至今零写入（空表）**。**形状缺陷（本 spec 动因）**：现表 `direction('pay'/'receive')` 折叠了 `CashObligation.kind` 三元（"付款"/"收款"/"开票"→开票并入 pay，读表无法还原）；`amount_cents INTEGER NOT NULL` 使"未填金额"（CashObligation.amount=undefined）与"0 元"不可区分；`status('pending'/'settled')` 丢原始中文状态。消费链：summary route（route.ts:30-36,82）`listConfirmedMetaDocRows`→映射→`deriveCashObligations`→`obligationsInMonth`→响应 obligations + 传 `deriveAttentionItems`。meta 流转：`setKnowledgeDocumentMeta`（sqlite.ts:678）两调用方——MCP 工具（document-metadata.ts:56，硬写 draft）与前端 PATCH（app/api/knowledge/documents/[id]/route.ts:22，可 confirmed）；**confirmed 无落盘钩子；`deleteDocument`（pipeline.ts:78）与 `setKnowledgeArchived` 均不清理义务行（悬空源）**。哨兵：cash-obligations.test.ts 纯函数 AC1-8 不测 persist；attention/cockpit-page 测试均内存构造，读表切换不碰断言。量级：confirmed 文档几十~几百，全量重派生开销极低。finance-store 无任何 obligations 读函数。

## 0. 目标与非目标

**目标**：义务数据从"每次读时现算"变为"落盘事实+写时同步"：① v9 重建 `fact_obligations`（修形状缺陷，空表零风险）+ 迁移内回填存量 confirmed 文档；② 写钩子全覆盖（confirmed→重派生落盘；取消确认/删除/归档→清行）；③ finance-store 新增读函数，summary route 切换读表；`deriveCashObligations` 纯函数保留为唯一派生器。

**非目标**：attention/前端消费形状改动（读函数还原出与现在完全相同的 `CashObligation[]`）；义务的独立编辑功能；fact_obligations 的 provenance 填充（WP4b）；往来管理 WP13（本 spec 只是它的数据地基）。

## 1. 成功标准（先红后绿）

- [ ] **v9 `obligations_reshape`**：DROP 并重建 `fact_obligations`——`id PK · kind TEXT NOT NULL CHECK(kind IN ('pay','receive','invoice')) · amount_cents INTEGER NULL · due_date TEXT NOT NULL · counterparty TEXT · status TEXT NOT NULL('pending'/'settled') · status_raw TEXT（原始中文状态）· **source_doc TEXT NULL（直接存派生输出的 sourceDoc 已解析值——reviewer B4：derive 的 sourceDoc 优先取 metadata.sourceFile，仅靠 JOIN file_name 无法等价还原）** · recurrence TEXT NULL · source_document_id INTEGER NOT NULL · settlement_status TEXT NOT NULL DEFAULT 'derived' · source TEXT NOT NULL DEFAULT 'agent_derived' · provenance TEXT NULL · derived_at TEXT NOT NULL DEFAULT (datetime('now'))`；索引 due_date 与 source_document_id。**DROP 前处置（reviewer B1，撤销 v1.0 的中止断言——它保护的只可能是旧缺陷形状的语义错误行，中止反而造成迁移死锁）**：表非空时 console.warn 记录行数与将被丢弃的事实（透明不静默），照常 DROP 重建。**迁移内回填**：SQL 读 confirmed 文档（listConfirmedMetaDocRows 支持传 db 参数，可直接复用，无循环引用）→ deriveCashObligations → 新 persist。**回填约束：derive 已保证 dueDate 非空行才输出（cash-obligations.ts:76-77 跳过无期限行），due_date NOT NULL 是对回填逻辑的守卫而非风险**。golden-schema 同步。
- [ ] `persistDerivedObligations` **INSERT 语句完全重写**（reviewer B2——不是调映射逻辑，现 INSERT 列清单与新表不兼容会直接 SQL 报错）。新目标列清单：`(kind, amount_cents, due_date, counterparty, status, status_raw, source_doc, recurrence, source_document_id, settlement_status, source, provenance)`；kind 映射（付款→pay/收款→receive/开票→invoice）、amount undefined→NULL（非 0）、status_raw 存原文、source_doc 存 obl.sourceDoc、**分转换加 0.005 精度校验超差抛错**（关闭 WP1a 遗留 N3）。
- [ ] **写钩子四路全覆盖**：PATCH route `metaStatus==='confirmed'` → 重派生落盘；PATCH 改回 none/draft → DELETE 该文档行；`deleteDocument` → DELETE；`setKnowledgeArchived(true)` → DELETE（取消归档→重派生）。每路一组测试（构造文档→触发→断言表行）。
- [ ] finance-store 新增 `listCashObligations(db): CashObligation[]`：sourceDoc 直读 source_doc 列（不再 JOIN 还原），kind 映射回中文，status 返回 status_raw 原文，amount NULL→undefined，done=status==='settled'——**与 deriveCashObligations 输出逐字段等价**。等价性测试：同一组文档，派生 vs 读出——**amount 字段用 |a-b|<0.005 误差容忍比较，其余字段严格相等**（reviewer N1：元→分→元 round-trip 的浮点 deepEqual 脆性）。
- [ ] summary route 切换：删除读路径的 derive 调用，改调 `listCashObligations`；响应 obligations 与 attention 输入形状不变（既有 cockpit/attention 测试不改断言跑绿）。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | 追加 v9（重建+回填；开工先验证 MIGRATIONS 末尾是 v8） |
| `lib/domain/cash-obligations.ts` | 修改 | persist 适配新形状+精度校验 |
| `lib/db/finance-store.ts` | 修改 | 新增 listCashObligations |
| `app/api/knowledge/documents/[id]/route.ts` | 修改 | PATCH 钩子（confirmed 落盘/降级清行） |
| `lib/knowledge/pipeline.ts` | 修改 | deleteDocument 清行 |
| `lib/db/sqlite.ts` | 修改 | setKnowledgeArchived 清行/重派生（若归档函数在别处，以现场为准并报告） |
| `app/api/cockpit/summary/route.ts` | 修改 | 读切换 |
| `tests/obligations-live.test.ts` | 新增 | v9 形状/回填/四路钩子/读写等价 |
| `tests/fixtures/golden-schema.json` | 修改 | 同步 |
| `scripts/knowledge-reset.mjs` | 修改 | **第五条写路径（reviewer B5）**：DELETE knowledge_documents 后同步 `DELETE FROM fact_obligations`，防幽灵义务行 |
| `tests/all.test.ts` | 修改 | 注册（文件末尾追加） |

## 3. 实施步骤

1. 红测试（建库样板抄 db-facts-migration 的临时路径模式）。
2. v9 迁移（回填逻辑注意：迁移在 runMigrations 事务内，deriveCashObligations 是纯函数可安全 import 调用——与 v1 baseline 调 initializeSchema 同模式）。
3. persist 适配 + 读函数 + 等价性测试。
4. 四路钩子。
5. summary route 切换 + 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?   # 必须 EXIT=0 零 unhandledRejection
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- ~~v1.0 的空表中止断言已撤销~~（reviewer B1）：表非空只可能是旧缺陷形状的语义错误行，处置=warn 行数后照常 DROP（见 §1 v9 条目），不中止。
- 钩子与落盘同一事务吗：PATCH 路径建议 setKnowledgeDocumentMeta 与 persist 同事务（原子性）；实施按 sqlite.ts 现有事务惯例，做不到同事务则顺序执行并在 audit 说明（失败面=极小窗口的表滞后，读侧无损坏）。
- PATCH route 对非法 metaStatus 静默默认 'draft'（route.ts:19-20，会静默触发清行钩子）——既有行为，本刀不改（改 400 是行为变更超范围），记录给后续（reviewer N2）。
- **与 WP1c 并行协调（reviewer N4）**：两 spec 共享 lib/db/finance-store.ts（WP1b 加 listCashObligations，WP1c 加 getInvoiceLedgerBreakdown+扩 recordInvoices），orchestrator 已定实施串行（WP1b 先），本 spec 的 implementer 无需关心。
- 被否决：① 保留现形状接受降级读（kind/金额语义静默错误，违反红线）；② 读时懒同步（悬空行无法清理、首读延迟）；③ ALTER 改列（表空，重建最干净）。
