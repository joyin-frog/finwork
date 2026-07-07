# 往来管理落地·合同应收层（WP13a：receivables-officer 转正 + 应收账龄闭环）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审剩 §1:18 旧核销措辞（与 orchestrator 抢修赛跑已消除）与 Files touched:29 旧描述（本版修正），按"修复即批准"条款生效）
> 状态：**已实施并通过审查（ship）**。实施审查唯一阻塞系 WP11 并行注册误归属（撤销有据）；N2 今日到期分箱缺口等三处琐碎项由 orchestrator 修复，全量复跑绿。
> 用户拍板（2026-07-07）：v1 = **合同应收层**——只用既有 fact_obligations（kind='receive'）数据，应收清单+约定回款日账龄+催款清单草稿；回款核销走既有链路（用户确认合同已收→文档 metadata 更新→义务 settled）。销项发票登记与发票级账龄留 WP13b。
> 依赖：WP1b（已ship，fact_obligations 落盘活数据）。零 DDL。
> 架构事实（2026-07-07 scout 核实）：receivables-officer 预留于 registry.ts:112-129（available:false、tools:[]、skills:["xlsx"] 待建 receivables-ledger、deliverables aging_report/dunning_list、rolePrompt 已含三条边界：催款函只出草稿/账龄口径显式声明/差异三分类）。转正机械面全就绪：role-registry.test.ts G5 按 available 过滤 spawn 枚举（flip 后自动纳入）、subagent-runner.ts:86-90 spawn 双重防线、agents 页 agent-card.tsx:82-107 的 available 门控自动解锁。数据面：`listCashObligations()`（finance-store.ts:725）可读 kind='receive' 义务（amount_cents/due_date/counterparty/status/status_raw/source_doc）；**子代理无义务读取工具**（tools:[] 且 SHARED_TOOLS 无此能力）。账龄/催款零先例。skill 样板=rnd-deduction-check（清单产出同构）。哨兵：receivables/aging/dunning 在 tests/ lib/ 零命中。工具接线三件套惯例（WP1c 已验证）：TOOL_REGISTRY(category finance)+renderers summaries(T6 守卫)+role tools 裸名(resolveBare)。

## 0. 目标与非目标

**目标**：receivables-officer 转正为可派发角色，交付合同应收闭环：① 新只读工具 `query_receivables`（kind='receive' 义务清单，每条带 `agingDays`——以约定回款日 due_date 与今天的日期差，确定性计算在工具内完成，LLM 零心算）；② 新技能 `receivables-ledger`（应收清单 → 账龄分箱呈现（未到期/逾期 1-30/31-60/61-90/90+，边界数字在 SKILL 正文集中为一处字面量清单，reviewer N4）→ 催款清单草稿，口径声明"账龄自约定回款日起算"）。**核销措辞定案（reviewer B2，消除误导性预期）**：SKILL 必须如实分场景声明——主对话场景："告诉我某合同款已收，我会把合同状态改为已收（草稿），**你在知识库页面点击确认后**，应收清单才会更新"（主对话有 record_document_metadata 全集权限，可起草）；子代理场景：receivables-officer 无 metadata 写工具，SKILL 指示其在结果中注明"核销请回到主对话操作"——禁止任何"告诉我即可更新完成"式措辞；③ registry 转正（available:true + skills + tools + dataScope 更新）。

**非目标**：销项发票写入端与发票级账龄（WP13b）；回款落盘表/银行流水核销（WP13b+）；催款函自动发送（红线：只出草稿）；驾驶舱应收卡片（attention 已有义务到期规则，新卡片等使用反馈）；账龄口径可配置（v1 固定约定回款日并显式声明）。

## 1. 成功标准（先红后绿）

- [ ] `query_receivables` MCP 只读工具（riskLevel safe，category finance）：入参可选 `includeSettled`（默认 false）与**可选 `asOf`（YYYY-MM-DD，缺省今天——供测试确定性断言 agingDays，reviewer N3，先例 loadTaxConfig 的 asOf）**；返回 structuredContent `{items:[{counterparty, amountCents(可 null), dueDate, agingDays(整数，due_date−asOf，未到期为正——v1.2 复审 N1 笔误修正), status('pending'/'settled'), statusRaw(中文原文), sourceDoc}], totalCount, overdueCount, amountUnknownCount}`。**数据来源定案（reviewer N2）**：listCashObligations 只回中文 status 且金额已转元——工具层**直查 fact_obligations 表**（或扩展 finance-store 新函数返回原始行），拿分值原样与 status/status_raw 双字段，**不做元→分回转**（reviewer N1 的单位混淆风险以此消除）；agingDays 复用 cash-obligations 的 daysBetween(today, dueDate)（已支持注入 today）。金额 NULL 进 `amountUnknownCount` 且 items 保留。接线三件套：TOOL_REGISTRY + renderers（T6）+ 只挂 receivables-officer。
- [ ] `agent-skills/skills/receivables-ledger/SKILL.md`（frontmatter 样板 rnd-deduction-check）：流程=query_receivables → 账龄分箱（分箱边界写死在 SKILL 正文，呈现用表格：未到期/1-30/31-60/61-90/90+）→ 逾期项生成催款清单草稿（对手方/金额/逾期天数/合同来源，措辞克制）→ 末尾三条固定声明：账龄口径（约定回款日）、金额未知 N 笔已列出未计入合计、**核销方式按 §0 B2 定案的分场景措辞**（主对话=起草已收+知识库确认后生效；子代理=回主对话操作；禁止"告诉我即可更新完成"）。金额合计一律来自工具返回的分值换算，禁止心算。
- [ ] registry 转正：available:true；skills 加 "receivables-ledger"（保留 xlsx）；tools 加 "query_receivables"；dataScope 更新为 ["fact_obligations（读，kind=receive）", "documents 合同收付义务（读）"]。role-registry 全部 G 守卫绿（G5 枚举自动纳入）。
- [ ] **tests/agent-role-toggle.test.ts 更新（reviewer B1——转正后必红的物理断言）**：118-122 行 T1-1f 断言"对 available:false 的 receivables-officer setRoleDisabled 抛错"，翻转后改为正向断言（receivables-officer 可正常 setRoleDisabled 启停，注释同步说明转正日期），audit 列出。
- [ ] agents 页零改动自动解锁（验证性确认写 audit，不改 UI 代码）。
- [ ] skills-store 测试扩展：真实目录发现 receivables-ledger（抄 filing-precheck 的 FP 测试块模式，嵌入现有 IIFE）。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint；golden-schema 零改动自证。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/finance-store.ts` | 修改 | 新增读函数直查 fact_obligations（kind='receive'，amount_cents 分值原样，status/status_raw 双字段），供 query_receivables 调用（§1 N2 定案，listCashObligations 已排除） |
| `lib/agent/mcp-tools/finance-tools.ts` | 修改 | query_receivables 工具定义 |
| `lib/agent/tools/registry.ts` | 修改 | 注册（safe/finance） |
| `lib/agent/tools/renderers.ts` | 修改 | summaries 中文摘要（T6） |
| `lib/agent/roles/registry.ts` | 修改 | receivables-officer 转正四字段 |
| `agent-skills/skills/receivables-ledger/SKILL.md` | 新增 | 技能定义 |
| `tests/receivables-live.test.ts` | 新增 | 工具行为（agingDays 正负/金额 NULL 语义/includeSettled）+ 转正守卫 |
| `tests/skills-store.test.ts` | 修改 | 新技能发现断言块 |
| `tests/role-registry.test.ts` | 修改（如物理断言要求） | 角色清单断言更新 |
| `tests/agent-role-toggle.test.ts` | 修改 | T1-1f 从"available:false 抛错"改为转正后正向启停断言（reviewer B1） |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试。2. 数据读函数+工具+接线三件套（跑 T6/G 守卫）。3. SKILL.md。4. registry 转正。5. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **agingDays 的"今天"**：工具入参 asOf 缺省今天（reviewer N3 定案）——测试传固定 asOf 与已知 due_date 断言精确差值，零日期脆性。
- 义务数据可能为空（用户没确认过合同）：工具返回空清单，skill 引导"上传合同并确认关键信息后即可跟踪应收"——空态不是错误。
- 被否决：① 新建应收台账独立表（fact_obligations 已是合同应收的事实源，再建表=双头真相）；② 账龄分箱在 SQL 里算（分箱是呈现逻辑，数据层给原始 agingDays 更灵活）；③ 挂 treasury-officer（资金专员边界是"只读核对"，应收跟进是往来域职责，跨挂稀释角色边界）。
