# 薪税结构化差异复核（payroll-diff-review）Spec

> 版本 v1.0 / 2026-07-05
> 状态：~~草案~~ → ~~已批准~~ → **已实施并 ship**（实施审查 fix-first 抓出卡片负 delta 丢负号，已直接修复+D10 回归测试锁定；全套 + typecheck 绿）
> 依赖：无（F4 薪税闭环的第一刀；导出交差是第二刀，本期不做）
> 架构事实（写给没读过代码库的全新上下文实现者）：
> - 财务 Agent = Next.js + Tauri + `@anthropic-ai/claude-agent-sdk`（TS）；财务工具是 MCP 工具，`sdk.tool(name, desc, zodSchema, handler)`，handler 返回 `{content:[{type:"text",text}], structuredContent, isError?}`。只读工具是普通 `sdk.tool`（参照 `query_payroll_status`，`lib/agent/tools/finance/payroll.ts:241-281`）；写工具才包 `withIdempotency` + `{riskLevel}`。
> - **薪税数据已在 SQLite（`lib/db/finance-store.ts`）**：`StoredPayrollRecord`（:133-156）含每人每月 `grossPay/socialInsurance/housingFund/specialDeduction/taxCurrent/netPay` + 全套累计字段 + `taxConfigVersion` + `status:"draft"|"confirmed"`。可用函数：`listPayrollRecords(year, month)`（:255，取某期全部记录）、`getLatestConfirmedPayroll(name, year, month)`（:239，取某人该年 month 之前最近一条 confirmed）。
> - **计算引擎已有且扎实**（不在本期改动）：`calculate_payroll_batch` 走确定性引擎 `lib/domain/tax-cumulative.ts`，精度到分，税率档从 `app_settings.tax_config`（`loadTaxConfig`）读、缺省 `lib/domain/tax-config.ts`。每人明细可追溯（三步 formula）已在 `PayrollResultCard` 里 `<details>` 可展开。
> - **工具结果 → 卡片渲染链（已有）**：`app/components/tool-cards.tsx` 的 `ToolResultCard` 按裸工具名分发；`TOOLS_WITH_RESULT_CARD`（:17）是白名单；每个工具有一个 `parseXxxStructured`（如 `payroll-card-data.ts`）把 `structuredContent` 整形成卡片 props，**解析失败返回 null 回退纯文本，"宁可不渲染,不可凑数"**。
> - PII：文本输出经 `redact()`（`lib/safety/pii`）；金额格式化 `formatCny`（`lib/format`）；金额精度校验 `checkMoneyPrecision`（`lib/safety/numeric-check`）。员工姓名允许出现（base/role prompt 只禁身份证/银行卡号）。
> - 测试栈：`npm test` = `node --import tsx tests/all.test.ts`（聚合，新文件须 import 进 all.test.ts；无 jsdom）。纯函数测试仿 `tests/ask-user-multi.test.ts`；领域纯函数仿 `lib/domain/tax-cumulative.ts` 有对应 `tests/*-script`/单测；源码契约仿 `tests/tool-call-step-ui.test.ts`。

## 0. 目标与非目标

**目标**：给薪税专员一个**只读的结构化差异复核工具** `diff_payroll_period`——把某月工资**草稿**与每位员工**上月已确认**数据做代码级对比，返回按变动幅度排序的差异清单（税前/五险/公积金/专项/个税/实发 的环比变动 + 新增员工 + 漏算/离职员工），在对话里渲染成可核对的差异卡。把"谁跟上月对不上、差在哪"从**LLM 口述**（脆弱、易漏比）升级为**确定性代码计算**。这是"怕错 > 怕累"的兜底检查，复核者级、建立"这事我只信它"。

**非目标（本期不做，已知并接受）**：
- ❌ 导出交差（工资条/个税申报表/银行代发表 Excel）——F4 第二刀，另立 spec。
- ❌ 差异**原因判定**：工具只给客观 delta + 事实标记（新增/漏算/税率版本不同），**不猜因果**（"为什么涨"留给人/模型解释）。避免把推测当事实（红线 3）。
- ❌ 改动计算引擎、`calculate_payroll_batch`、确认流程、社保基数核算。
- ❌ 社保/公积金基数辅助计算。
- ❌ 自动确认或基于差异自动改数——工具只读，绝不写。
- ❌ 引入 jsdom / 新依赖。

## 1. 成功标准

**A. 差异计算（纯函数，`lib/domain/payroll-diff.ts`，可自动验证）**
- [ ] `computePayrollDiff(current, priorByName, priorRoster)` 纯函数：对每个 current 员工，与 `priorByName` 里其上月 confirmed 记录逐字段算 delta（grossPay/socialInsurance/housingFund/specialDeduction/taxCurrent/netPay），delta = `round2(current - prior)`，**精度到分不漂移**。验证：单测喂构造数据断言 delta 正确、精度正确（如 3000.10 - 1000.05 = 2000.05）。
- [ ] **新增员工**：current 有、priorByName 无 → 标 `flag:"new"`（"本月无上月确认记录，新员工/冷启动，需核累计起点"）。**漏算/离职**：`priorRoster`（上月 confirmed 花名册）有、current 无 → 进 `dropped` 列表（"上月有、本月缺，是否离职或漏算"）。验证：单测覆盖新增、漏算两种。
- [ ] **排序**：有 prior 的差异按"该员工各字段 |delta| 的最大值"降序（变动最大排最前）；新增、漏算作为高优先异常单列在前。验证：单测断言排序。
- [ ] **税率版本差异**：current 记录 `taxConfigVersion` 与 prior 不同时标 `flag:"tax_config_changed"`（口径提示）。验证：单测。
- [ ] 零差异员工可选择性折叠（`changed:false`），但仍计入总数。

**B. 工具接线（源码契约 + 只读语义）**
- [ ] `diff_payroll_period` 工具注册在 `payroll.ts` 的 `createPayrollTools`，只读（**不写库、不包 withIdempotency**），入参 `{year, month}`，内部读 `listPayrollRecords` + `getLatestConfirmedPayroll` + 上月花名册，调 `computePayrollDiff`，返回 `{content:[redact(text)], structuredContent}`。
- [ ] 在 `tools/registry.ts` 注册，`riskLevel:"safe"`（只读，不触发确认门）。
- [ ] 加入 `payroll-officer` 角色 `tools` 白名单（`roles/registry.ts`）；`renderers.ts` 加 `getToolSummary` 条目。
- [ ] 文本输出经 `redact()`；`structuredContent` 只含姓名 + 金额 delta，**无身份证/卡号**。

**C. 渲染（源码契约）**
- [ ] 新增 `payroll-diff-card.tsx` + `payroll-diff-card-data.ts`（`parsePayrollDiffStructured`，解析失败返回 null）；在 `tool-cards.tsx` 的 `TOOLS_WITH_RESULT_CARD` 加 `diff_payroll_period`、`ToolResultCard` 加分发分支。卡片：**明确标注"本月草稿 vs 上月已确认"**（结算状态标签，防当环比趋势读），差异按幅度排序、变动用 tone token 高亮、新增/漏算醒目、tabular-nums 金额（复制 `ReimbursementResultCard` 表格 + `--tone-notice` 模式）。
- [ ] 卡片数字与 `structuredContent` **完全一致**（宁可不渲染不凑数）。

**D. 不回归**：现有薪税工具/卡片不变；全套测试绿；typecheck 过。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/domain/payroll-diff.ts` | 新增 | 纯函数 `computePayrollDiff` + 类型（`PayrollDiffResult` 等）。无 DB、无副作用。 |
| `lib/db/finance-store.ts` | 修改 | 加只读 helper `getPriorConfirmedPeriod(year, month)`（返回 <当前期 最近一个有 confirmed 记录的 {year,month}，无则 null）——供取上月花名册。 |
| `lib/agent/tools/finance/payroll.ts` | 修改 | `createPayrollTools` 加 `diff_payroll_period` 只读工具；返回加进数组。 |
| `lib/agent/tools/registry.ts` | 修改 | 注册 `diff_payroll_period`，`riskLevel:"safe"`。 |
| `lib/agent/roles/registry.ts` | 修改 | `payroll-officer.tools` 加 `diff_payroll_period`。 |
| `lib/agent/tools/renderers.ts` | 修改 | 加 `diff_payroll_period` 的 `getToolSummary` 条目。 |
| `app/components/payroll-diff-card-data.ts` | 新增 | `parsePayrollDiffStructured`：structuredContent → 卡片 props，严格校验，残缺回 null。 |
| `app/components/payroll-diff-card.tsx` | 新增 | 差异卡组件（表格 + 变动高亮 + 新增/漏算 + "草稿 vs 已确认"标签）。 |
| `app/components/tool-cards.tsx` | 修改 | `TOOLS_WITH_RESULT_CARD` 加名；`ToolResultCard` 加分发分支。 |
| `tests/payroll-diff.test.ts` | 新增 | ①纯函数（delta/精度/新增/漏算/排序/税率版本）；②源码契约（工具只读注册 safe、角色白名单、redact、卡片分发、结算状态标签）。导出 `payrollDiffTestPromise`。 |
| `tests/all.test.ts` | 修改 | 接入 `payrollDiffTestPromise`。 |

> 需动列表外文件就停下报告，不擅改。

## 3. 实施步骤

1. **纯函数（`lib/domain/payroll-diff.ts`）**：定义 `PayrollDiffField = {prior:number; current:number; delta:number}`、`PayrollDiffRow = {employeeName; fields:Record<字段,PayrollDiffField>; maxAbsDelta:number; changed:boolean; flags:string[]}`、`PayrollDiffResult = {rows:PayrollDiffRow[]; newEmployees:string[]; dropped:string[]; comparedFromPeriod:string|null}`。`computePayrollDiff(current: StoredPayrollRecord[], priorByName: Map<string,StoredPayrollRecord>, priorRoster: string[])`：逐人算 6 字段 delta，**delta 用 `Math.round(a*100 - b*100)/100`**（先各自乘 100 再相减，比 `Math.round((a-b)*100)/100` 更稳，避免 `(1000.1-0.1)*100` 尾差），标 new/tax_config_changed，算 maxAbsDelta 与 changed；dropped = priorRoster 里不在 current 的名字；rows 按 new 优先、再按 maxAbsDelta 降序。**纯函数不碰 DB。**
2. **store helper（`finance-store.ts`）**：`getPriorConfirmedPeriod(year, month, db?)`：SQL `SELECT year, month FROM payroll_records WHERE status='confirmed' AND (year < ? OR (year = ? AND month < ?)) ORDER BY year DESC, month DESC LIMIT 1`，返回 `{year,month}|null`。**注释里点明它与既有 `getPayrollPeriodSummary.latestConfirmedPeriod` 的区别**：后者返回全局最新 confirmed 期、不过滤当前期（可能返回当前期本身），本函数严格 `< 当前期`——别误用后者替代。
3. **工具（`payroll.ts`）**：`diff_payroll_period({year,month})`：
   - `current = listPayrollRecords(year, month)`；空 → 友好提示"该月无工资记录"。
   - **⚠ 评审 P1 修正——priorByName 与 priorRoster 必须同一来源期间，且不得用年内查询的 `getLatestConfirmedPayroll`**：后者 SQL 是 `WHERE year=? AND month<?`（年内），1 月计薪时 `month<1` 恒空，会让上月（去年 12 月）全员误判为"新增"、去年 12 月花名册误判为"漏算"，每年 1 月必炸。正确做法——用**单一上月已确认期间**同时构建两者：
     ```
     const p = getPriorConfirmedPeriod(year, month);           // 跨年，返回 <当前期 最近的 confirmed 期
     const priorRecords = p ? listPayrollRecords(p.year, p.month).filter(r => r.status === "confirmed") : [];
     const priorByName = new Map(priorRecords.map(r => [r.employeeName, r]));
     const priorRoster = priorRecords.map(r => r.employeeName);
     ```
     这样跨年正确，且全员用同一基准期比较（更符合"本月 vs 上月"环比语义）。**本工具不再调用 `getLatestConfirmedPayroll`。**
   - `const diff = computePayrollDiff(current, priorByName, priorRoster)`；把 `p` 格式化成 `comparedFromPeriod`（复用 `formatPeriod`，见步骤 4）回传。
   - 文本：`redact()` 包裹的摘要（"N 人有差异，最大变动：X 实发 ±¥…；新增 K 人；⚠ 漏算/离职嫌疑 M 人：…"）+ 排序清单。
   - `structuredContent: {year, month, comparedFromPeriod: diff.comparedFromPeriod, ...diff}`。
   - 只读，不 `savePayrollDraft`、不 `withIdempotency`。
4. **注册（⚠ 评审 P2——三处必须原子同提交，中间态测试必红）**：`tools/registry.ts` 加 `{name:"diff_payroll_period", category:"finance", riskLevel:"safe"}`；`roles/registry.ts` 的 `payroll-officer.tools` 加 `"diff_payroll_period"` 裸名；`renderers.ts` 加 `getToolSummary` 条目（**复用既有 `formatPeriod(i)`**，如 `diff_payroll_period: (i)=>\`复核 ${formatPeriod(i)} 工资差异\``）。
   - **原子性**：`role.tools` 加裸名后，`resolveRoleAllowedTools` 需能在 `TOOL_REGISTRY` 找到全名，否则 `resolveBare` 抛错；且 `role-registry.test.ts`(G1/G4d) 要求 role.tools 全部可解析、`tool-renderers.test.ts`(AC7) 要求所有 finance 工具有中文摘要。因此 **registry.ts + renderers.ts + roles/registry.ts 三处改动必须一并完成再跑测试**（建议先加这三处注册再实现工具体，或全部写完再一次性跑），不要在中间态执行 `npm test`。
5. **卡片**：`payroll-diff-card-data.ts` 严格解析（字段缺失/类型不符 → null）；`payroll-diff-card.tsx` 复制 `ReimbursementResultCard`（tool-cards.tsx:52）的表格 + 图标 + tone 模式，顶部一条 `--tone-notice` 标签写"本月草稿 vs 上月已确认（{comparedFromPeriod}）· 仅供复核，非环比分析"；`tool-cards.tsx` 加白名单 + 分发分支。
6. **测试**：见 §4。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/payroll-diff.test.ts   # 开发时单跑
npm run typecheck
```
（注：套件里 `AC6.2` 类用例会把 `typecheck` 纳入门禁，typecheck 不过测试即红。）

- 新增测试（进 `tests/payroll-diff.test.ts`，接入 `all.test.ts`）：
  1. 纯函数 `computePayrollDiff`：delta 正确 + 精度到分不漂移（**含 `.1` 类边界，如 `1000.1 - 0.1 = 1000` 精确、`3000.10 - 1000.05 = 2000.05`**）；新增员工标记；漏算(dropped)；排序（变动大在前、new 优先）；税率版本变化标记；零差异 changed=false；**空 priorRoster（冷启动/首月）时全员 new、无 dropped**（覆盖跨年 1 月场景的等价路径——priorByName 与 priorRoster 同源，不会一边空一边有）。
  2. 源码契约：`payroll.ts` 含 `diff_payroll_period` 且**不含** `savePayrollDraft`/`withIdempotency` 于该工具体内（只读证据）、输出走 `redact`；`tools/registry.ts` 该工具 `riskLevel:"safe"`；`roles/registry.ts` payroll-officer 含该裸名；`tool-cards.tsx` 白名单 + 分发含 `diff_payroll_period`；卡片源码含"草稿"与"已确认"标签串。
- 真机目视（交付证据，非单测）：起 dev server，先 `calculate_payroll_batch` 造一个月草稿（可 mock），触发 `diff_payroll_period`，`preview_screenshot` 存差异卡。跑不动 audit 标"待人工目视"。
- 不需要跑：e2e、导出相关（本期不做）。
- 先跑基线全绿再改，改完再跑，零回归。

## 5. 风险与开放问题

- **【结算状态 · 必标】草稿 vs 已确认**：本工具比的是"本月草稿(未定版) vs 上月已确认(定版)"。这对**复核**是正确用途（就是要在草稿定版前抓异常），但**绝不能被当成环比趋势/对外数字**（data-trust：草稿 vs 已结账不可比）。卡片与文本必须显式标"草稿复核，非环比分析"。
- **不猜因果（红线 3）**：只给客观 delta + 事实标记，不输出"因为调薪所以涨"这类推断。原因解释留给人/模型在对话里做。
- **上月口径**：`getPriorConfirmedPeriod` 取的是"最近一个有 confirmed 的期间"，可能不是紧邻上月（如跳月）。`comparedFromPeriod` 必须回传并在卡片显示，让用户知道在跟哪个月比。税率版本不同时已标 `tax_config_changed`。
- **漏算检测的边界**：`priorRoster` 用上一个 confirmed 期间的花名册。若某员工是"上上月在职、上月已离职"，不会误报（只看紧邻的 confirmed 期）。但若历史确认不连续，dropped 可能有噪声——`dropped` 措辞用"嫌疑，请人工核"，不做定论。
- **精度**：金额已是 2 位小数元，delta 用 `Math.round((a-b)*100)/100` 防浮点尾差；展示 `formatCny`。不引 Decimal（与现有引擎一致）。
- **开放问题（不阻塞）**：是否把差异卡的每行也接 `<details>` 展开累计明细（复用 receipt-card）？MVP 不做——差异复核看的是环比变动，不是单人累计推导；需要看累计仍可点 `calculate_payroll_batch` 的原卡。

---

## 附录：audit（implementer 产出 `docs/spec/audit-payroll-diff-review.md`）
以 Files changed 清单开头（对照 §2）→ §1 逐条核对（命令+结果）→ 测试/typecheck 输出 → **只读性自查（不写库）+ 结算状态标注自查** → 偏离/遗留/风险。
