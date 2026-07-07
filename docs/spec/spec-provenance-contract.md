# 可追溯性泛化·第一刀（WP4a：receipt 判别契约 + 剩余 source 补链）Spec

> 版本 v1.1 / 2026-07-06（v1.0 计划审查 fix first：现状断言大面积过时——reimbursement/reconciliation 的 receipt 与 source、payroll 的 source 透传均已在历史提交（ffa8ff6 等）实现并有测试（tests/reimbursement-receipt / reconciliation-receipt / tax-cumulative-f2），scout 被过时 TODO 注释误导。本版按 reviewer 逐条核实的现状重写，只留真实缺口）
> 状态：**已实施并通过审查（ship）**。实施审查零阻塞（非阻塞记录：TX1/TX2 结构约定断言不触产码属已认可缺口、tool-cards 双路径行为等价、日志计数文案过时）。复审附带（进实施要求）：reconciliation 工具的 zod 入参 schema 需同时加可选 bankFileName/bookFileName 字段，否则调用点永远只能传 undefined。
> 依赖：无。
> **核实后的现状（以此为准）**：`CalcReceipt`（lib/domain/receipt.ts）无 kind 判别字段，tool-cards.tsx:31-55 分发靠 `parseCalcReceiptStructured` 形状猜测。source 现状：payroll 已传 `[{ref:"payroll-${asOf}",recordCount:1}]`（payroll.ts:144，工程字符串、无接力信息）；reimbursement 已带 invoiceNo（buildReimbursementReceipt，reimbursement.ts:65；**其工具入参无 fileName/rowIndex 字段**——v1.0 的该要求系虚构，撤销）；reconciliation 已带 `{ref:"bank"/"book",recordCount}`（buildReconReceipt）但无文件名，且 `reconcileBankStatement(bankInput,bookInput,options)` 签名不含文件名——补文件名需动签名与调用方；**tax_calculator 的 source 恒 `[]`（finance-tools.ts:137，唯一确认的空 source）**。既有测试：tests/receipt.test.ts（字段断言、无整体 deepEqual）、reimbursement-receipt（RE-T1~8）、reconciliation-receipt（RR-T1~9）、tax-cumulative-f2（F2-T1~4）——新断言**并入这些既有文件**，不建新测试文件（无 all.test.ts 改动）。

## 0. 目标与非目标

**目标**：① **kind 判别契约**（定案设计，见 §2）；② **tax_calculator source 补链**（真空缺）；③ **payroll source 产品语言化**：现有 `ref:"payroll-${asOf}"` 条目保留（机器可读锚点），追加人类可读来源条目（"本次对话提供的工资明细"/"接力 YYYY-MM 已确认记录"——接力信息在 payroll.ts:110-119 调用点作用域内可得）；④ **reconciliation 补文件名**：`reconcileBankStatement` 增可选 `fileNames?: {bank?:string; book?:string}` 参数，工具调用点传入（有附件名则传）。

**非目标**：voucher 系列与 business_analysis 接入（WP4b）；provenance 落库与 fact_payroll 补列（WP4b）；reimbursement 的 source 改造（已达标）；ReceiptCard UI 改动。

## 1. 成功标准（先红后绿）

- [ ] `CalcReceipt.kind: "calc_receipt"`（必填字面量）；`validateCalcReceipt` 对**缺 kind 但形状合格的输入做归一化——补上 kind 后返回**（normalization 而非拒绝：调用方签名与返回类型完全不变，旧持久化数据自动升级，reviewer B2 的二义性以此定案）；`makeCalcReceipt` 自动填 kind。测试：带 kind 通过、缺 kind 归一化后带 kind、形状不合格拒绝。
- [ ] tool-cards 分发：`structured?.kind === "calc_receipt"` 优先直走 ReceiptCard；否则走既有形状猜测（validate 归一化保证输出一致）。三路径测试。
- [ ] tax_calculator：source 按入参组装（vat：`金额 <amount> 元与税率 <rate>（本次对话提供）`；cit 同理），非空断言进 tests/receipt.test.ts 或就近既有测试。
- [ ] payroll：追加人类可读来源条目；有接力时含"接力 YYYY-MM 已确认记录"，冷启动时含"调用方提供的年初累计"。断言并入 tax-cumulative-f2 或 payroll 工具既有测试。
- [ ] reconciliation：传了文件名时 source 的 bank/book 条目带文件名，没传行为不变。断言并入 reconciliation-receipt.test.ts。
- [ ] 既有四个 receipt 测试文件全绿；kind 追加若使某字段级断言红，属结构演进型更新，audit 逐处列出；四文件之外的测试要改断言则停下报告。
- [ ] 全量绿 + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/domain/receipt.ts` | 修改 | kind 字段 + validate 归一化 + makeCalcReceipt 填 kind |
| `app/components/tool-cards.tsx` | 修改 | 判别优先分发 |
| `lib/agent/mcp-tools/finance-tools.ts` | 修改 | tax_calculator source 组装（137 行处） |
| `lib/agent/tools/finance/payroll.ts` | 修改 | source 追加产品语言条目（接力/冷启动分支） |
| `lib/domain/reconciliation.ts` | 修改 | reconcileBankStatement 增可选 fileNames 参数，receipt source 带文件名 |
| `lib/agent/tools/finance/reconciliation.ts` | 修改 | 调用点传文件名（reviewer N4 补列） |
| `tests/receipt.test.ts` | 修改 | kind/归一化/分发三路径 + tax_calculator source 断言（就近原则） |
| `tests/tax-cumulative-f2.test.ts` | 修改 | payroll source 产品语言断言 |
| `tests/reconciliation-receipt.test.ts` | 修改 | 文件名断言 |

无新测试文件、无 all.test.ts 改动。

## 3. 实施步骤

1. 红测试（三个既有测试文件各补断言块）。
2. receipt.ts kind+归一化（此步后跑全量确认 kind 追加的涟漪范围，红的字段级断言按 §1 规则更新）。
3. tool-cards 判别分发。
4. 三个 source 补链逐个做（每个跑对应测试）。
5. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test && npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- source 措辞用财务语言不用工程术语（"本次对话提供的工资明细"√ / "args.employees"×）。
- 归一化设计的代价：validate 有了写入行为（补 kind）——可接受，它本就构造返回对象；纯校验语义留给形状不合格的拒绝路径。
- 被否决：① validate 返回 legacy 标记（调用方类型涟漪大，归一化零涟漪）；② 全局 structuredContent envelope（一次动全部工具审不完）；③ 给 reimbursement 虚构 fileName/rowIndex 字段（v1.0 错误，其入参无此信息；单据文件定位等 OCR 管线有据可依时再说）。

> 计划审查记录：v1.0 裁决 fix first——B1 现状断言过时（已按 reviewer 核实重写，工作范围收窄至真实缺口四项）；B2 kind 兼容二义（定案归一化设计，签名零变）；B3 payroll source 歧义（定案保留机器锚点+追加产品语言条目）；N1/N2 测试并入既有文件、四文件列入 Files touched；N3 tax_calculator 字段来源写明；N4 reconciliation 工具调用点补列。