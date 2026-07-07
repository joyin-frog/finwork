# 节奏引擎·第一刀（WP2a：确定性预检规则扩容 + LLM 预检跳转入口）Spec

> 版本 v1.1 / 2026-07-06（v1.0 计划审查 fix first，B1-B3/N1-N5 已修订，待限定复审）
> 状态：**已实施并通过审查（ship）**。实施审查零阻塞；哨兵 C2a2 收窄经授权；三条非阻塞（断言冗余/守卫 no-op/audit 注记过时）已记录。
> 依赖：WP3（filing-precheck 已ship，提供 LLM 预检的对话入口）；WP1a（fact_* 读取口）。
> **D4 落地方式的重解释（写给用户与 reviewer）**：D4 原文"打开驾驶舱时触发预检，跑前显示预计消耗可跳过"。摸底发现用量层无任何事前预估先例（lib/usage/quota.ts 只做事后累计）。本 spec 把预检拆两类以免造预估机器：**确定性预检**（读 fact_* 就绪状态，零 LLM 消耗）在 summary API 里直接跑、结果进异常清单——"打开驾驶舱触发"字面兑现；**LLM 型预检**（勾稽复核）做成 attention 项里的跳转入口（`/chat/new?prompt=...`），hint 注明"将发起对话、消耗额度"——点击=跑、不点=跳过，额度由对话侧既有护栏管。不新增开关、不做后台常驻（无先例且 D4 已否决）。
> 架构事实（2026-07-06 scout）：`deriveAttentionItems(calendar, payroll, obligations)`（lib/domain/attention.ts）现有五条规则，`AttentionItem{id,source,sourceLabel,roleId?,severity,title,actions[{label,href,primary?}],occurredAt?}`，actions 统一 `/chat/new?prompt=<encoded>` 跳转（app/chat/new/page.tsx 读 searchParam 作 initialDraft）；`sortAttentionItems` 自动排序。summary 数据流：GET /api/cockpit/summary → getCalendarContext / getPayrollPeriodSummary / listConfirmedMetaDocRows→deriveCashObligations / deriveAttentionItems / listBlockedDispatches / getBusinessOverview（route.ts:20-80），前端挂载时调一次+手动刷新，无轮询。就绪状态读取口：getPayrollPeriodSummary（fact_payroll）、getInvoiceLedgerStats(year,month)（fact_invoices，总量/本月新增）、getBusinessOverview（fact_metrics 月/季/年）。fact_obligations 读取归 WP1b，本期义务数据继续走 deriveCashObligations 动态派生。app_settings KV（getAppSetting/setAppSetting）可用但本期不需要。

## 0. 目标与非目标

**目标**：驾驶舱从"被动展示"迈出主动化第一步——新增三条确定性预检规则 + 一条 LLM 预检入口规则，全部进现有异常清单（AttentionSection 零 UI 改动）。

**非目标**：后台定时任务；消耗预估机器；预检完成态追踪（点过的入口不消失——报税期内常驻是特性不是缺陷，复核可以做多次）；fact_obligations 读表切换（WP1b）；驾驶舱 UI 改版；用户开关。

## 1. 成功标准（每条先写红测试）

- [ ] **R6 申报前复核入口（LLM 型）**：`calendar.windows` 含 `tax_filing` 时产出 normal 级 attention 项，title"申报前复核（发起对话，消耗额度）"，action 跳转 `/chat/new?prompt=<starter>`，roleId='tax-officer'。**starter 获取机制（reviewer B2 定案）**：调用方（summary route 与 agents route）在调 `deriveAttentionItems` 前经 `lib/agent/skills-store.ts` 的既有解析函数读 filing-precheck 的 frontmatter starter，作为**字符串参数**传入——纯函数保持无 I/O、测试传假串即可；读取失败时传 undefined，R6 降级为跳转 `/chat/new`（无预填 prompt），不抛错。与既有 `tax-filing`（截止≤5 天 urgent）规则并存不互斥；**边界用例：15 日当天两者同时在清单**（reviewer N2，进测试矩阵）。
- [ ] **R7 台账断档（确定性）**：当月 15 日后且 `getInvoiceLedgerStats` 本月新增=0 → normal 项"本月发票台账零登记，请自查是否漏登"，action 跳转对话（prompt 引导登记/自查）。
- [ ] **R8 上月经营指标未登记（确定性）**：每月 5 日后且 `hasMetricsForMonth(上月)` 为 false → normal 项，action 跳转对话引导登记。
- [ ] 三条新规则的输入全部经 summary route 传入 `deriveAttentionItems`（保持纯函数，测试不碰 DB 用构造参数）。
- [ ] 排序与既有规则共存：urgent 仍在前；新规则在既有测试（cockpit-todos/cockpit-today-counts 等）不回归的前提下追加。
- [ ] 全量测试绿 + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/domain/attention.ts` | 修改 | 纯函数加三条规则；入参扩为携带 invoiceStats 与 metricsPresence（新增轻量类型） |
| `app/api/cockpit/summary/route.ts` | 修改 | 组装两个新输入（调 getInvoiceLedgerStats + 上月 metrics 存在性查询）传入 |
| `lib/db/finance-store.ts` | 修改 | **无条件新增** `hasMetricsForMonth(year,month)`（只读布尔查询，reviewer B3——getBusinessOverview 拉全量三视角太重不复用） |
| `app/api/agents/route.ts` | 修改 | **第二调用方（reviewer B1）**：112 行也调 deriveAttentionItems，同步传新参数；其 55 行已有 getInvoiceLedgerStats 结果在作用域内可直接复用（reviewer N5） |
| `tests/attention-precheck.test.ts` | 新增 | 三规则各红→绿：触发/不触发/边界（15 日双规则并存、5 日、窗口外）；fixture 模式参照既有 `tests/attention.test.ts`（R1-R5 的构造法，reviewer N1） |
| `tests/all.test.ts` | 修改 | 注册新测试 |
| `tests/cockpit-v3-slim.test.ts` | 修改 | 实施中发现的哨兵（88 行 C2a2 禁 summary route 源码含 getInvoiceLedgerStats，旧意图=响应不带 invoices 字段）：收窄为断言响应对象无 invoices 键（原意保全，允许内部调用派生 attention）。implementer 停下报告，orchestrator 2026-07-06 批准增补 |


## 3. 实施步骤

1. 红测试（纯函数构造参数，模式抄 attention 现有测试若有、否则参照 cockpit-todos 测试的构造法）。
2. attention.ts 三规则 + 类型扩参。调用方共两处：summary route 与 agents route（B1），都要传新参；新参数带默认值兜底但两处都显式传。R7 的"当月几日"从既有 calendar.isoDate 拆取（attention.ts:31 已有此模式），**不加冗余 now 参数**（reviewer N3）。
3. summary route 组装输入。
4. finance-store 的 hasMetricsForMonth（无条件新增）。
5. 全量验证。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test && npm run typecheck && npm run lint
```
- 既有 cockpit-* 测试不改断言跑绿（若新规则改变了它们构造场景下的清单内容，优先调整新规则触发条件的测试场景边界，仍不行则停下报告——那说明规则设计与既有断言冲突，需要裁决）。

## 5. 风险与开放问题

- **R7/R8 的"几日后"阈值**（15 日/5 日）是我的提案值，无政策依据纯产品判断——reviewer 与用户可调；写成 attention.ts 顶部具名常量。
- R6 每次报税期常驻可能被觉得烦——接受（normal 级不刺眼；完成态追踪等 WP2b 有事实依据后再说）。
- 被否决：① 消耗预估机器（无先例、v1 不值）；② 后台定时（无先例、D4 已否决常驻）；③ 预检结果落库成新表（现阶段 attention 是纯派生视图，落库引入状态同步复杂度无消费方）。
