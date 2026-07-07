# 发票写入端补字段 + 台账读工具 + A4 升级（WP1c）Spec

> 版本 v1.1 / 2026-07-07（v1.0 计划审查 fix first，B1-B3/N1/N4 已修订，待限定复审）
> 状态：**已实施并通过审查（ship）**。实施审查零阻塞。非阻塞记录：breakdown 的 uncertified/directionUnknown 为全局计数（月过滤语义留后续小改，audit 已标注）；taxAmountCents 精度超差走抛出与既有 yuanToCents 惯例一致；spec 的 riskLevel "low" 系笔误（实际枚举 safe/medium/high，implementer 正确用 safe）。
> 依赖：WP1a（已ship，fact_invoices 六个新列已在 schema 只是无人供值）；与 WP1b 并行开发但**迁移无涉**（本 spec 零 DDL）；若与 WP1b implementer 同时跑注意 finance-store.ts 共享（orchestrator 调度串行）。
> 架构事实（2026-07-07 scout 核实）：fact_invoices 唯一写入 `recordInvoices`（finance-store.ts:398-419，INSERT 仅六列，direction/tax_rate/tax_amount_cents/certification_status/counterparty/provenance 全部不写）；上层唯一进路 `record_reimbursement_invoices` 工具（reimbursement.ts:66-107，zod 仅 invoiceNo/amount/invoiceDate/category/conversationId）。**单据→凭证管线与金蝶工具不写台账**（scan_slip_folder/process_voucher_batch 为外部 MCP 名，与 recordInvoices 零交集）。filing-precheck A4（SKILL.md:63-66）无文件时输出固定"请自查"提示。registry.ts dataScope 旧表名 4 处（37/60/82/140）。source 列 NOT NULL 无 DEFAULT，两写入路径均显式供值；SQLite 改既有列 DEFAULT 须重建表。哨兵：reimbursement-ledger/db-facts-migration G4/finance-summary 均为形态断言不涉列值，扩 INSERT 列不破坏；**golden-schema 无涉（不加列不改 DDL）**。findInvoicesInLedger/getInvoiceLedgerStats 不依赖新字段无需动。

## 0. 目标与非目标

**目标**：发票台账从"只有票号+金额的黑盒"变成带方向/税额/对手方的可核查事实：① 写入端——`record_reimbursement_invoices` 工具 zod 加可选 `taxRate/taxAmountYuan/counterparty`，**direction 由工具写死 'in'**（报销场景恒进项，不靠模型判断），`recordInvoices` 扩 INSERT 全列（缺省 NULL）；② 读出端——新增 MCP 只读工具 `query_invoice_ledger`（本期汇总：总张数/进项张数与税额合计分/未认证数/**方向未标注数**），挂 tax-officer 与 bookkeeper 工具白名单；③ filing-precheck A4 升级为调用该工具的自动检查（NULL 诚实呈现："其中 N 张历史记录未标注方向，无法计入"）；④ 清尾：registry dataScope 4 处旧表名更新。

**非目标**：source 列补 DEFAULT（**正式关闭 WP1a 遗留 N1 为"不做"**：需重建整表，两写入路径已显式供值，防御收益撑不起重建风险）；凭证管线接台账（外部 MCP，无本仓写入点）；OCR 自动填税率（工具字段是"调用方提供"，识别质量归 OCR 管线）；provenance 填充（WP4b）。

## 1. 成功标准（先红后绿）

- [ ] 工具 zod：`taxRate`（字符串枚举校验交给 loadTaxRates 合法集？否——报销票税率多样，本期仅格式校验 0<rate<1 的数字字符串或 NULL）、`taxAmountYuan`（number 可选，工具内转分）、`counterparty`（string 可选）；direction 恒 'in' 在 handler 写死；缺省全 NULL 落库。测试：全字段/零新字段/非法税率拒绝三路径。
- [ ] `recordInvoices` INSERT 覆盖全列（含 certification_status 参数化但本期工具不暴露——恒 NULL，字段留给电子税务局导入场景）；`InvoiceLedgerEntry` 类型同步扩展。
- [ ] `query_invoice_ledger` MCP 工具（只读，riskLevel low）：入参 year/month；返回 structuredContent：`{total, directionIn:{count, taxAmountCentsSum}, uncertifiedCount, directionUnknownCount}`。接线三件套（reviewer B1/B3）：① TOOL_REGISTRY 注册（category "finance"）；② **lib/agent/tools/renderers.ts 的 summaries 补 `query_invoice_ledger` 中文摘要条目**——tool-registry.test.ts T6 强制 finance 类工具必有 renderer，漏了必红；③ tax-officer/bookkeeper 的 `tools` 数组加**裸名** `"query_invoice_ledger"`（与现有条目同格式，resolveRoleAllowedTools 自动解析 mcp__finance_worker__ 前缀，写错裸名 resolveBare 会抛异常触发 G 守卫）。role-registry 测试跑绿。
- [ ] **主对话可用性前提（reviewer N4，从风险节升格为成功标准）**：filing-precheck 主对话执行时工具经 claude-adapter.ts:213 的 `ALLOWED_TOOLS` 全集可用，不依赖角色白名单——A4 升级不等白名单生效；白名单挂载是为子代理场景铺路。
- [ ] SKILL.md A4 更新：改为调用 query_invoice_ledger——本期有登记→报张数与进项税额合计并与上传文件互证；`directionUnknownCount>0` → 明示"N 张历史记录未标注方向未计入"；台账为空→保留原"请自查"提示。skills-store 相关测试跑绿。
- [ ] registry dataScope 4 处：invoice_ledger→fact_invoices、payroll_records→fact_payroll、business_metrics→fact_metrics。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint；golden-schema 零改动（自证：git diff 该文件为空）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/tools/finance/reimbursement.ts` | 修改 | zod 三可选字段 + direction 写死 'in' + 转分传递 |
| `lib/db/finance-store.ts` | 修改 | InvoiceLedgerEntry 扩展 + recordInvoices 全列 INSERT + 新增查询函数 `getInvoiceLedgerBreakdown(year,month)` 供工具层 |
| `lib/agent/mcp-tools/finance-tools.ts`（或按工具注册惯例的就近文件） | 修改 | query_invoice_ledger 工具定义 |
| `lib/agent/tools/registry.ts` | 修改 | 新工具注册（riskLevel low，category finance） |
| `lib/agent/tools/renderers.ts` | 修改 | summaries 补 query_invoice_ledger 中文摘要（T6 守卫强制，reviewer B1） |
| `lib/agent/roles/registry.ts` | 修改 | tax-officer/bookkeeper tools 白名单加新工具 + dataScope 4 处更新 |
| `agent-skills/skills/filing-precheck/SKILL.md` | 修改 | A4 段升级 |
| `tests/invoice-write-path.test.ts` | 新增 | 写入三路径/查询汇总/NULL 语义 |
| `tests/role-registry.test.ts` | 修改（如守卫要求） | 白名单断言更新 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试。2. 类型+recordInvoices。3. 工具 zod+handler。4. 查询函数+MCP 工具+注册（跑 tool-registry/role-registry 守卫）。5. SKILL.md A4。6. dataScope 清尾。7. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **税额单位**：工具入参用元（财务习惯），入库转分——**抄既有 `yuanToCents`（lib/db/finance-store.ts:200-208，round+0.005 校验已完整实现）**（reviewer B2 修正：v1.0 引用的"WP1b 修后模式"是尚不存在的悬空参照）。
- **taxRate 类型链（reviewer N1）**：zod 收数字字符串 → handler 内 parseFloat + 0<rate<1 范围检查 → 以 REAL 存库（fact_invoices.tax_rate 是 REAL），禁止字符串直传 INSERT 靠 SQLite 隐式转换。
- 新工具挂白名单后 filing-precheck 在主对话执行（工具全量可用），A4 无需依赖角色白名单——白名单挂载是为 bookkeeper/tax-officer 子代理场景铺路。
- 被否决：① source 补 DEFAULT（见非目标，正式关闭）；② taxRate 对照 loadTaxRates 合法集强校验（报销票种税率杂——6%/9%/13%/1%/3%/0 都常见，强校验会把合法票拒之门外，格式校验+人工复核够）；③ 把 certification_status 暴露给报销工具（报销场景拿不到认证状态，虚构字段是 WP4a-v1.0 的教训）。
