# 可追溯性第二刀（WP4b：voucher/分析接入 + CalcReceipt 落库）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审批准；复审建议的 §0 编辑性残留已修）
> 状态：**已实施并通过审查（ship）**（2026-07-07；实施审查零阻塞；遗留 N1：calc_receipts.conversation_id 各调用点未填（列可空不违约），线程化注入记 ROADMAP 待办）
> 依赖：WP4a（已ship）、WP14a（已ship）。**迁移占 v14，排 WP15(v12)、WP13b(v13) 之后串行实施；开工验证 migrations.ts 末条为 v13，否则停止报告。**
> 架构事实（2026-07-07 scout + orchestrator 精读核实）：
> - CalcReceipt 契约：lib/domain/receipt.ts——kind:'calc_receipt'/value/unit:'CNY'/rounding/steps[]/source[]/basis{caliberVersion,settlementStatus,asOf}/caveats?；makeCalcReceipt/validateCalcReceipt 归一化 kind（:95）。
> - 现有 receipt 生产方 4 个：payroll（tools/finance/payroll.ts）、reimbursement（domain/reimbursement.ts:93）、reconciliation（domain/reconciliation.ts:126）、tax_calculator（mcp-tools/finance-tools.ts:137）。
> - **receipt 目前不落库**——只存在于 chat_agent_events payload 的 structuredContent 里（证伪"已持久化"），会话删除即随 CASCADE 消失，无法回答"上月这笔数当时怎么算的"。
> - voucher 链路（mcp-tools/kingdee-tools.ts）：process_voucher_batch → build_voucher_lines / check_voucher_amount / map_voucher_account → export_voucher_list / export_kingdee_draft；各工具 structuredContent 是普通 JSON（:174,283,309,333,361,392,438,601），无 receipt 结构；批处理聚合在 lib/domain/voucher-batch.ts:156 processVoucherBatch。
> - 分析工具 generate_business_analysis（mcp-tools/business-analysis-tool.ts → buildBusinessAnalysisV2）：markdown + 普通分析 JSON，无溯源段。
> - fact_payroll（migrations :178-205）：有 settlement_status/caliber_version/source/detail_json，**无 receipt 关联列**。WP4a spec 明文把"provenance 落库与 fact_payroll 补列"划给 WP4b（spec-provenance-contract.md:11 非目标）。
> - artifacts 表 kind 体系与 structuredContent 的 kind 是两个命名空间（scout 核实无耦合）；calc_receipts 独立表语义更干净（artifacts.state=勾选语义对 receipt 无意义，artifact-store.ts:58 INSERT 写死 state）。
> - 哨兵：tests/receipt.test.ts（K1-K5/TX1-2）、reimbursement-receipt（RE-T1~8）、reconciliation-receipt（RR-T1~11）、tax-cumulative-f2（F2-T1~7）；voucher 测试无 receipt 断言；golden-schema/all.test.ts 惯例。

## 0. 目标与非目标

**目标**：receipt 从"会话内瞬时对象"变"可回查的持久事实"：① v14 `calc_receipts` 表 + `fact_payroll.receipt_id` 补列；② `saveCalcReceipt` 落库函数，4 个现有生产方在返回前落库（wrapper 型附 receiptId、receipt 本体型 tax_calculator 仅落库——详见 §1 两型定案）；③ voucher 链路接入——check_voucher_amount 与 process_voucher_batch 产出 CalcReceipt（value=合计金额分、steps=逐行/逐单据、source=文件名/单据引用）并落库，作为 structuredContent 的 `receipt` 子字段（**不改既有顶层形状**）；④ generate_business_analysis 增加 `provenance` 段（sources：fact_metrics 月份范围+记录数；caliberVersion；asOf）——**不强套 CalcReceipt**；⑤ fact_payroll 草稿写入回填 receipt_id。

**非目标**：receipt 查询 UI/历史回查页（表先立、写路径通，读等使用反馈）；voucher/分析卡片渲染改动（voucher structuredContent 顶层形状被既有消费方依赖，receipt 作子字段不触发 calc_receipt 卡片分发——渲染接入留给消息渲染重构 WP9b 后评估）；map_voucher_account/export 系工具接 receipt（映射与导出非计算，无 receipt 语义）；calc_receipts 的保留策略/清理（默认永久保留，审计属性）；其他 fact_* 表补 receipt_id（发票/指标行是登记非计算，provenance 列已有）。

## 1. 成功标准（先红后绿）

- [ ] **v14**：`calc_receipts`（`id INTEGER PK AUTOINCREMENT · tool_name TEXT NOT NULL · conversation_id INTEGER NULL · trace_id TEXT NULL · receipt TEXT NOT NULL(JSON，写入前过 validateCalcReceipt) · created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`，索引 conversation_id；**无会话 FK**——receipt 是长期计算凭据，须比会话长寿（同 audit_logs 设计理由）+ `fact_payroll` 补 `receipt_id INTEGER NULL`。golden-schema 同步。
- [ ] **saveCalcReceipt(db, {toolName, conversationId?, traceId?, receipt})**（新 lib/db/receipt-store.ts）：校验失败抛错不落库；返回 receiptId。落库失败不阻断工具返回（try/catch 记 warn——receipt 落库是增强不是主链路，降级断言进测试）。
- [ ] **4 个现有生产方接入**：handler 产 receipt 后调 saveCalcReceipt。**structuredContent 处理分两型（reviewer B1）**：
  - wrapper 型（payroll / reimbursement / reconciliation——structuredContent 是 {results, summary, …} 包装对象，receipt 是其中一员或另附）：wrapper 增 `receiptId` 字段，顶层其余形状不变；
  - **receipt 本体型（tax_calculator，finance-tools.ts:154 `structuredContent: receipt`）：structuredContent 一字不动、receiptId 不进 structuredContent，只落库**——形状是既有契约（tests/finance-tools-f3.test.ts F3-T1/T2 直断 .unit/.value/.steps + tool-cards kind 分发），落库已达成持久化目标；被否决：扩 CalcReceipt 类型加 receiptId（类型契约污染）、改 {receipt, receiptId} 包装（破坏 F3 与 kind 分发）。
  - 哨兵：4 组 receipt 测试 + **finance-tools-f3.test.ts（F3-T1/T2，reviewer N4 补列）**零改动跑绿；wrapper 型若有严格形状断言致红，扩断言不删。
- [ ] **voucher 接入**：check_voucher_amount 与 process_voucher_batch 构造 CalcReceipt（借贷合计/批次总额为 value，逐行/逐单据为 steps，输入文件与单据号进 source，basis.settlementStatus='draft'）并落库；structuredContent 增 `receipt` 与 `receiptId` 子字段，既有顶层字段与文字输出不变（voucher 既有测试零改动跑绿）。**check_voucher_amount 仅在 `result.ok === true` 时产 receipt（reviewer N3——reconcileAmount 对不平衡是返回 {ok:false} 而非抛错）**；金额单位实施时核实 reconcileAmount 返回值确为分（输入经 yuanToFen，reviewer N5），若为元须换算。
- [ ] **分析 provenance**：generate_business_analysis 的 structuredContent 增 `provenance: {sources:[{table:'fact_metrics', months, recordCount}], caliberVersion, asOf}`；markdown 尾部加一行溯源说明（中文）。**provenance 在 tool handler 层用 getDb() 组装（reviewer N2）——buildBusinessAnalysisV2 是无 DB 纯函数，保持不动**。
- [ ] **fact_payroll 回填**：savePayrollDraft（finance-store.ts:218-223，签名 (year, month, result, monthsEmployed, options?)）的 options 加可选 receiptId；INSERT 列清单与 **ON CONFLICT DO UPDATE 均含 receipt_id（重算草稿=新计算新回执，receipt_id 更新为新值——reviewer N1 定案）**；确认（confirm）不动 receipt_id。断言：草稿行 receipt_id 指向的 calc_receipts 行可反序列化且 basis.asOf 与期间一致；重算后 receipt_id 变为新 id。
- [ ] 测试（tests/receipt-store.test.ts）：迁移形状/落库与校验拒绝/落库失败降级/4 生产方 receiptId 存在且表有行/voucher receipt 形状（value=合计、steps 数=行数）/分析 provenance 段/payroll 回填链路；注册 all.test.ts 末尾。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint（警告不增）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v14 calc_receipts + fact_payroll.receipt_id |
| `lib/db/receipt-store.ts` | 新增 | saveCalcReceipt（+按需 getCalcReceipt 供测试断言） |
| `lib/agent/tools/finance/payroll.ts` | 修改 | 落库+receiptId+草稿回填 |
| `lib/agent/tools/finance/reimbursement.ts` | 修改 | 落库+receiptId |
| `lib/agent/mcp-tools/finance-tools.ts` | 修改 | tax_calculator 仅落库（structuredContent 一字不动，B1 定案） |
| `lib/agent/tools/finance/reconciliation.ts` | 修改 | :87 handler 落库+wrapper 加 receiptId（reviewer B2 核实：structuredContent 组装在此，domain/reconciliation.ts 不动） |
| `lib/agent/mcp-tools/kingdee-tools.ts` | 修改 | 两工具构造 receipt+落库+子字段 |
| `lib/domain/voucher-batch.ts` | 修改 | processVoucherBatch 输出补 receipt 构造所需聚合（若现返回值已够则不动，开工核实） |
| `lib/agent/mcp-tools/business-analysis-tool.ts` | 修改 | provenance 段+markdown 溯源行 |
| `lib/db/finance-store.ts` | 修改 | 工资草稿写入函数加可选 receipt_id |
| `tests/receipt-store.test.ts` | 新增 | §1 全部行为 |
| `tests/fixtures/golden-schema.json` | 修改 | v14 同步 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试（迁移形状/落库校验/降级）。2. v14+golden+receipt-store。3. 4 生产方接入（一次一个，跑各自哨兵）。4. voucher 两工具。5. 分析 provenance。6. payroll 回填。7. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **形状哨兵全清单（复审后已核实）**：receipt.test.ts / reimbursement-receipt / reconciliation-receipt / tax-cumulative-f2 / **finance-tools-f3.test.ts（F3-T1/T2 直断 tax_calculator structuredContent 字段——B1 定案后零改动跑绿即防线）**；wrapper 型 deepEqual 断言若红，扩断言不删，audit 说明每处。
- voucher receipt 的 value 语义（借贷平衡时=借方合计；不平衡时 check 工具本就报错不产 receipt）——实施中若发现 check_voucher_amount 对不平衡也返回 structured，receipt 只在平衡路径产出，caveats 记录。
- 被否决：① receipt 挂 artifacts 表（state 勾选语义不适配、kind 命名空间混淆，独立表干净）；② 全局 envelope 一次改所有工具（WP4a 已否决，diff 审不完）；③ 分析强套 CalcReceipt（多指标输出与单值信封不匹配，硬造 value 是伪精确——provenance 段达成同等可追溯性）；④ calc_receipts 挂会话 CASCADE（计算凭据须长寿）；⑤ voucher structuredContent 顶层替换为 receipt（破坏既有消费方，diff 不可控）。
