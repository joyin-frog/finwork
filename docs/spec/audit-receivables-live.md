# Audit: receivables-live (WP13a)

> 实施日期：2026-07-07

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/db/finance-store.ts` | 修改：新增 `listReceivablesRaw` 函数与 `ReceivableRawRow` 类型 |
| `lib/agent/mcp-tools/finance-tools.ts` | 修改：新增 `query_receivables` 工具定义；import `listReceivablesRaw` |
| `lib/agent/tools/registry.ts` | 修改：注册 `query_receivables`（safe/finance） |
| `lib/agent/tools/renderers.ts` | 修改：新增 `query_receivables` 中文摘要（T6 守卫） |
| `lib/agent/roles/registry.ts` | 修改：receivables-officer 转正四字段（available/skills/tools/dataScope） |
| `agent-skills/skills/receivables-ledger/SKILL.md` | 新增：应收账龄台账技能定义 |
| `tests/receivables-live.test.ts` | 新增：RL-1～RL-6 测试（agingDays 正负/NULL 语义/includeSettled/转正守卫） |
| `tests/skills-store.test.ts` | 修改：FP-5 发现断言块（receivables-ledger 真实目录发现） |
| `tests/role-registry.test.ts` | 未改动（G 守卫自动纳入转正角色，无物理行改动） |
| `tests/agent-role-toggle.test.ts` | 修改：T1-1f 从"available:false 抛错"改为转正后正向启停断言 |
| `tests/all.test.ts` | 修改：末尾追加 receivables-live.test.ts 注册 |

## 各文件改动内容

### `lib/db/finance-store.ts`
新增 `listReceivablesRaw(db?, opts?)` 函数：
- 直查 `fact_obligations` 表，`kind = 'receive'`
- `amount_cents` 分值原样返回（不转元，N1 定案）
- `status/status_raw` 双字段原样返回（N2 定案）
- `agingDays = daysBetween(asOf, due_date)`（自实现，复用同逻辑）
- `includeSettled=false` 时只返回 `status='pending'` 行
- `asOf` 缺省今天，测试可传固定值（N3 定案）
- 导出 `ReceivableRawRow` 类型

### `lib/agent/mcp-tools/finance-tools.ts`
新增 `query_receivables` 工具：
- 入参 `includeSettled?: boolean`（默认 false）、`asOf?: string`
- 调用 `listReceivablesRaw`
- 返回 `structuredContent {items, totalCount, overdueCount, amountUnknownCount}`
- 空清单引导上传合同而非报错
- 挂在 `createFinanceTools` 返回数组末尾

### `lib/agent/tools/registry.ts`
在 `query_invoice_ledger` 下方新增一行：
```
{ name: "query_receivables", category: "finance", riskLevel: "safe" }
```

### `lib/agent/tools/renderers.ts`
在 `query_invoice_ledger` 摘要下方新增：
```
query_receivables: (i) => { ... } // 中文摘要"查询应收账款清单（含已收）"
```
AC7 守卫自动验证新工具有中文摘要。

### `lib/agent/roles/registry.ts`
receivables-officer 转正：
- `available: false` → `true`
- `skills: ["xlsx"]` → `["receivables-ledger", "xlsx"]`
- `tools: []` → `["query_receivables"]`
- `dataScope` → `["fact_obligations（读，kind=receive）", "documents 合同收付义务（读）"]`
- 注释更新说明转正日期

### `agent-skills/skills/receivables-ledger/SKILL.md`
frontmatter 样板参照 `rnd-deduction-check`，含：
- `name/title/summary/requires/starter/category/description`
- 执行流程：query_receivables → 账龄分箱（五级，边界字面量集中在一处）→ 逾期催款草稿
- 末尾三条固定声明：账龄口径/金额未知/核销分场景措辞（B2 定案）
- 主对话场景：起草已收草稿 + 知识库确认后生效
- 子代理场景：回主对话操作，无"告诉我即可更新完成"式措辞

### `tests/receivables-live.test.ts`（新增）
RL-1～RL-6 六个断言：
- RL-1: agingDays 正值精确断言（asOf=2026-07-10, due=2026-07-20 → 10）
- RL-2: agingDays 负值精确断言（asOf=2026-07-10, due=2026-07-01 → -9）
- RL-3: amountCents=null 行保留、不填 0
- RL-4: includeSettled=false 过滤已结算；=true 包含；非 receive 不入
- RL-5: structuredContent 完整形状（items/dueDate/status/statusRaw/sourceDoc/分值原样）
- RL-6: receivables-officer available=true + skills 含 receivables-ledger + tools 含 query_receivables

### `tests/skills-store.test.ts`
在现有 filing-precheck FP 测试块（IIFE）内 finally 之前，追加 FP-5：
- 真实 agent-skills 目录发现 receivables-ledger
- source=bundled / enabled=true / editable=false

### `tests/agent-role-toggle.test.ts`
T1-1f（原 118-122 行）：从断言"available:false 抛错"改为转正后正向断言：
- `setRoleDisabled("receivables-officer", true)` 成功，disabled 列表包含该 id
- `setRoleDisabled("receivables-officer", false)` 成功，disabled 列表移除该 id
- 注释说明转正日期 2026-07-07

### `tests/all.test.ts`
末尾 invoiceWritePathTestPromise 之后追加：
```ts
const { receivablesLiveTestPromise } = await import("./receivables-live.test.ts");
await receivablesLiveTestPromise;
```

## 与计划的偏差

1. **role-registry.test.ts 无物理改动**：G3 守卫已动态检查 `role.skills` 对应目录，receivables-ledger 目录创建后自动通过；G5 守卫已在转正时自动纳入枚举（ROLE_REGISTRY 按 available 过滤）；G7 守卫通过 role-ui.ts 已有 `"receivables-officer": "往来专员"` 匹配。spec 说"如需更新 audit 列出"，无需更新，此处列明说明。

2. **`listReceivablesRaw` 而非直接在工具内查询**：spec §1 说"直查 fact_obligations 表（或扩展 finance-store 新函数返回原始行）"，选用后者以便测试直接调用不需要 sdk mock。

## 测试结果

```
RL-1: agingDays 正值（未到期）✓
RL-2: agingDays 负值（逾期）✓
RL-3: 金额 NULL 语义 ✓
RL-4: includeSettled 过滤 ✓
RL-5: structuredContent 形状 ✓
RL-6: receivables-officer 转正守卫 ✓
receivables-live: 全部 RL 断言通过 ✓

全量 EXIT=0 / typecheck 零错误 / lint 零错误（139 个预存 warnings 均不属于本次改动）
golden-schema 零改动自证
```

## agents 页自动解锁验证

`app/agents/agent-card.tsx:24`：`const isDisabled = !card.available || card.userDisabled`

receivables-officer 的 `available` 已从 `false` 翻为 `true`，无需改动 UI 代码，agents 页对该角色卡片将自动呈现为可用状态。

## 开放风险

- **子代理工具访问**：receivables-officer 的 `tools: ["query_receivables"]` 通过 `resolveRoleAllowedTools` 解析为全名 `query_receivables`，符合 G1/G4d 守卫要求。
- **账龄口径**：v1 固定约定回款日（due_date），口径写入 SKILL.md 并在每次输出中显式声明。销项发票级账龄留 WP13b。
- **核销链路**：主对话有 `record_document_metadata` 权限可起草草稿，子代理无此工具——SKILL.md 分场景声明已覆盖，禁止任何"告诉我即可更新完成"式措辞。

---

## 实施审查裁定与修复记录（orchestrator，2026-07-07）

裁决 fix first 的唯一阻塞 B1（all.test.ts 双注册"越界"）**撤销**：parseCorpusTestPromise 系并行的 WP11 implementer 自行注册（其报告明确记载），跨任务未提交 diff 误归属（本轮改造第四次同类误判）；WP11 已全绿，两注册共存无风险。
非阻塞修复（orchestrator 直接动手，琐碎例外）：N2 分箱边界改"未到期（含今日到期）= agingDays ≥ 0"（消除今日到期项被静默丢出双箱的真缺陷）；N4 rolePrompt 口径歧义改为"v1 固定自约定回款日起算"；N1 spec 符号笔误修正。修复后全量 EXIT=0。N3（红态无 git 快照）为流程已知项。

**最终裁决：ship。**
