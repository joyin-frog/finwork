# 总览页 v2 Spec：活化（关注区 / 最近工作 / 团队面板 / 期间徽章 / 信任标签）

> 版本 v1.1 / 2026-07-02（v1.1：左列顺序调整——经营数据与最近工作提到合同收付之上，评审决定）
> 前置依赖：`spec-role-registry.md`——仅 Phase 3（团队面板、gate_blocked 供给源）依赖其 `subagent_dispatches` 表；Phase 0–2 无依赖，可先行。
> 前序：`spec-cash-obligations-cockpit.md`（合同收付→待办管道，本 spec 吸收其呈现层）；`spec-overview-redesign.md`（2026-06-07 历史版布局，已被现状迭代，本 spec 取代其未尽事项）。
> 架构事实：cockpit 为 client 组件、单次 fetch `/api/cockpit/summary`（`app/cockpit/page.tsx:37`）；日历为客户端纯函数 `getCalendarContext`；tone token 家族（`--tone-alarm/warn/notice/ok/neutral/skill/payroll/invoice`）与组合类 `fa-toned` / `fa-tone-pill` / `fa-tone-edge` / `fa-tone-dot`、脉冲动画 `fa-dot-pulse` 均已存在（`app/globals.css`）。

---

## 0. 目标、已拍板立场与非目标

**目标**：总览页从「静态查询的陈列」变成「Agent 工作成果的物化视图」——新增关注区、最近工作、团队面板、期间徽章四个区块，建立全产品复用的信任四级标签组件，并清除页面上最后的死数据（QuickActionsCard 的 5 条硬编码 prompt）。

**已拍板立场（讨论结论，实现时不再重开）**：

1. **关注区吸收 TodosCard**。规则推导的待办只是关注区的供给源之一，页面上不同时存在「待办」和「需要你关注」两个区块。
2. **团队面板低拟人**。中文角色名（财务真实岗位词汇）+ 域图标 + 域色；不做人头像、不做性格、不做「他说」。信任来自工作记录，不来自人设。
3. **空态与生长时刻单独设计**（§8）。冷启动第一天的页面和「第一次委派后角色卡诞生」的瞬间是生长叙事的成败处。

**非目标**：

- 不动：MetricStrip 前 3 格、CashObligationsCard、BusinessMetricsCard 主体、FinanceCalendarCard、ComplianceStrip。
- 不做：导航改造（另议）、开屏巡检（P1 另起 spec）、期间感知的 Agent 谨慎度（agent 侧，另起）、`check_finding` 供给源（依赖「发现落表」机制，见 §12 开放问题）。

---

## 1. 信息架构：v1 → v2

```
┌ header (h-11) ──────────────────────────────────────────────┐
│ [☰] 总览  6月30日 周二  [报税期 · 距截止3天]*        [刷新] │
├──────────────────────────────────────────────────────────────┤
│ 派活入口*（全宽一行，placeholder 随日历窗口轮换）             │
│                                                              │
│ 需要你关注*（全宽；空态时收为一行）                           │
│   ┌ 卡片 1（urgent 置顶）┐ ┌ 卡片 2 ┐ …  [还有 N 项 ∨]      │
│                                                              │
│ MetricStrip（4 格；第 4 格「待办」→「需要关注」）             │
│                                                              │
│ ┌ 左 2/3 ──────────────────────┐ ┌ 右 1/3 ────────────────┐ │
│ │ ┌ BusinessMetrics ┐┌ 最近   ┐│ │ 团队面板* / 生长引导卡 │ │
│ │ │ （不动）        ││ 工作*  ││ │ FinanceCalendar（不动）│ │
│ │ └─────────────────┘└────────┘│ │                        │ │
│ │ CashObligationsCard（不动）   │ │                        │ │
│ └──────────────────────────────┘ └────────────────────────┘ │
│                                                              │
│ ComplianceStrip（不动）                                      │
└──────────────────────────────────────────────────────────────┘
* = 本 spec 新增
```

槽位变化：

| 现状 | v2 |
|---|---|
| `QuickActionsCard`（5 条硬编码 prompt） | **删除**。发起职能由「派活入口」承接，情境建议由关注区空态与 placeholder 承接；原槽位给「最近工作」 |
| `TodosCard`（右列） | **删除**。产物改造为关注区供给源；右列槽位给「团队面板」 |
| MetricStrip 第 4 格「待办 N 条」 | 「需要关注 N 项」，count = attention.length，含 urgent 时 alarm 色（逻辑照搬现状 `metric-strip.tsx:86-94`），点击平滑滚动到关注区 |
| 左列顺序：CashObligations 在上 | **经营数据 + 最近工作提到合同收付之上**（评审决定：经营视图与工作流回看比合同日历更高频；卡片本身均不改，只调 `page.tsx` 的槽位顺序） |

响应式沿用现状断点（`lg:grid-cols-3` / `md:grid-cols-2`）；关注区与派活入口全宽，不参与分栏。

---

## 2. Phase 0：TrustBadge 组件与 tone 家族扩展

### 2.1 推导函数 `lib/domain/trust-tier.ts`

```ts
export type TrustTier = "verified" | "pending" | "inferred" | "unverified";
export type TrustSource = "engine_calc" | "file_parse" | "user_dictated" | "llm_inferred";
export type TrustStatus = "confirmed" | "draft" | "none";

export function deriveTrustTier(source: TrustSource, status: TrustStatus): TrustTier;
```

推导矩阵（**不新增数据库 confidence 字段，一切现场推导**；纵轴来源，横轴状态）：

| source \ status | confirmed | draft | none |
|---|---|---|---|
| engine_calc | 已核实 | 待确认 | 待确认 |
| file_parse | 已核实 | 待确认 | 待确认 |
| user_dictated | 已核实* | 未核实 | 未核实 |
| llm_inferred | 推测** | 推测 | 推测 |

\* 用户口述且经确认流程确认后升为已核实（如未来对话录数带确认门）。
\*\* LLM 结论永远封顶「推测」，确认动作确认的是「已阅」而不是「为真」——衍生数据不能反哺为事实（红线 3）。

### 2.2 组件 `app/shared/trust-badge.tsx`

`<TrustBadge tier={...} sourceLabel? />`，渲染为 `fa-tone-pill`，tone 映射：

| tier | 文案 | tone |
|---|---|---|
| verified | 已核实 | `--tone-ok` |
| pending | 待确认 | `--tone-warn` |
| inferred | 推测 | `--tone-neutral` |
| unverified | 未核实 | `--tone-unverified`（新增） |

`sourceLabel` 可选追加来源短语（如「用户口述」），拼为「未核实 · 用户口述」。

### 2.3 globals.css 新增 token（深浅两套，规格对齐现有家族）

```css
/* 浅色（L/C 对齐 --tone-* 家族 0.55-0.60 / 0.10-0.12） */
--tone-unverified: oklch(0.55 0.02 260);   /* 低饱和灰，与四级中最弱的信任感对应 */
--tone-tax: oklch(0.57 0.10 220);
--tone-treasury: oklch(0.56 0.10 190);
--tone-receivables: oklch(0.56 0.10 290);
--tone-analysis: oklch(0.58 0.10 105);
/* 深色（L 抬到 0.72，对齐现有 dark 段） */
```

角色 tone 复用 + 新增的完整映射放 `lib/domain/role-ui.ts`（client-safe，**不 import `lib/agent`**）：

| roleId | tone | 说明 |
|---|---|---|
| bookkeeper | `--tone-invoice`（复用） | 发票/单据是其主要对象 |
| payroll-officer | `--tone-payroll`（复用） | 已存在 |
| tax-officer | `--tone-tax` | 新增 |
| treasury-officer | `--tone-treasury` | 新增 |
| receivables-officer | `--tone-receivables` | 新增 |
| analyst | `--tone-analysis` | 新增 |

域图标从语义图标注册表（Hugeicons 体系）选取，`role-ui.ts` 一并给出。具体 oklch 值以视觉调试台微调为准（globals.css 的调试台约定），spec 值为起点。

---

## 3. Phase 1：关注区（吸收 TodosCard）

### 3.1 数据形状 `lib/domain/attention.ts`

```ts
export type AttentionItem = {
  id: string;
  source: "rule" | "gate";        // 预留 "patrol"(巡检) | "finding"(核查异常，开放问题)
  sourceLabel: string;            // 中文短标签：合同收付 / 申报截止 / 工资草稿 / 算薪窗口 / 结账窗口（rule 类）；停在确认门（gate 类，Phase 3）
  roleId?: string;                // gate/patrol 类有，rule 类无
  severity: "urgent" | "normal";
  title: string;                  // 主文案，沿用现有 todo label 的措辞风格
  actions: { label: string; href: string; primary?: boolean }[];
  occurredAt?: string;            // gate 类 = dispatch ended_at；rule 类可空
};
```

- `deriveCockpitTodos` 改名/改造为 `deriveAttentionItems`，推导逻辑（合同收付临近、申报截止 ≤5 天、工资草稿待确认、算薪窗口未开算、结账窗口）**原样保留**，只换输出形状：`label→title`，`href→actions[0]`（主动作），`sourceLabel` 按来源填。
- gate 类（Phase 3 接入）：查 `subagent_dispatches WHERE blocked_reason IS NOT NULL AND ended_at > datetime('now','-7 day')`，title = 「{角色名}的工作停在确认门：{summary 首行}」，主动作 = 回到原对话（`/chat/recent?id={conversation_id}`）。
- 排序：urgent 全部在前；同级按 dueDate/occurredAt 升序。默认显示 5 条，其余折叠为「还有 N 项」展开。

### 3.2 卡片 UI

每卡一行到两行的紧凑卡（`--surface` 卡 + 细边，不做大卡）：

```
[● urgent 脉冲] [fa-tone-pill 源标签] 标题文案            [主动作] [次动作]
```

- urgent 用现有 `fa-dot-pulse`；源标签 tone：rule 类用 `--tone-notice`，gate 类用对应角色 tone。
- **rule 类不带 TrustBadge**（它们是系统推导的日历/状态事实，加徽章是噪音）；gate/patrol/finding 类带（那是 Agent 产出）。
- 动作就是链接（`/chat/new?prompt=` 或 `/chat/recent?id=`），**不引入新的写路径**——门在对话里的工具层，不在按钮层。

### 3.3 派活入口

- header 之下全宽一行：input 样式（复用现有 Input 组件），Enter 提交 → `router.push("/chat/new?prompt=" + encodeURIComponent(text))`。
- placeholder 按当前日历窗口轮换，文案集中在 `lib/domain/cockpit-suggestions.ts` 单文件（报税期 / 算薪 / 结账 / 平峰各 1-2 条，如「报税期：让税务专员跑一遍申报前检查」）。这是引导文案不是数据，允许写死，但**必须收敛在这一个文件**。

---

## 4. Phase 2：最近工作 + 期间徽章 + 口述数据标签

### 4.1 最近工作卡（占原 QuickActions 槽位）

- summary 扩 `recentWork`：`{ conversationId, title, status: "running"|"done"|"error", roleIds: string[], updatedAt }[]`，取 8 条。会话与状态复用 `/api/chat/recent` 已有的推导；`roleIds` 由 `subagent_dispatches` 按 conversation_id 汇（Phase 3 前恒为空数组，UI 优雅降级不显示角色 chip）。
- 行式列表（不做卡中卡）：状态点（running=主色脉冲、done=`--tone-ok`、error=`--tone-alarm`，对齐侧栏会话点的语义）+ 标题截断 + 角色 chip（≤2 个，角色 tone pill）+ 相对时间。点击整行 → `/chat/recent?id=`。
- 与侧栏「最近对话」的关系：同一份数据的两种密度，本卡只取 8 条且带角色维度；置顶概念不进本卡。

### 4.2 期间徽章（header，日期右侧）

- `getCalendarContext(now).windows` → 徽章，`fa-tone-pill`：
  - `filing`（报税期）：daysLeft ≤3 → `--tone-alarm`，≤7 → `--tone-warn`，否则 `--tone-notice`（与 MetricStrip 第 1 格逻辑一致，抽公共函数）；
  - `payroll_prep`（算薪窗口）/ `closing`（结账窗口）：`--tone-notice`。
- **平峰不渲染徽章**——该出现的时候出现，不该出现的时候让位。多窗口并存只显优先级最高的一枚（filing > payroll_prep > closing），hover title 列全部。

### 4.3 口述数据接 TrustBadge（信任标签第一个消费样例）

- 迁移：`business_metrics.source` 从自由文本收敛为枚举 `engine_calc | file_parse | user_dictated | llm_inferred`（现存量 `'agent'` 迁移映射为 `user_dictated`——现状该表数据全部来自对话录入）；`record_business_metrics` 工具写入侧同步。
- BusinessMetricsCard 数字旁挂 `<TrustBadge tier={derive(...)} sourceLabel="用户口述" />`。这是红线 3 在 UI 的第一次可见落地。

---

## 5. Phase 3：团队面板与生长时刻（依赖 spec-role-registry Phase 2）

### 5.1 数据

summary 扩 `team`：`{ roleId, name, charter, dispatchCount, lastAt, lastSummary }[]`，由后端 JOIN `ROLE_REGISTRY`（name/charter 的单一事实源在注册表，前端 `role-ui.ts` 只管 tone/icon，不复制文案）与 `subagent_dispatches` 的 `GROUP BY role_id`。

### 5.2 渲染与生长规则

- **整卡仅当 `team.length > 0` 渲染**——从未派过活，页面上没有「团队」这个概念。
- 行结构：圆形域图标（`fa-toned` 底，角色 tone）+ 角色名 + charter 一行截断 + 右侧「N 次 · 相对时间」；hover title 显示 lastSummary。v1 无点击交互（开放问题 §12）。
- **低拟人红线**：无人像、无性格文案、无第一人称；唯一的「人味」是中文岗位名。
- **生长时刻**：client 用 `localStorage`（key `cockpit.seenRoleIds`）记录已见角色；fetch 后发现新 roleId → 该行播放入场动效（沿用 `spec-ui-motion.md` 的入场约定，`prefers-reduced-motion` 降级为直接出现）。整卡首次出现同理。

### 5.3 冷启动右列（团队面板缺位时）

渲染「生长引导」mini-card：dashed 细边 + muted 文案「把活派给我，你的财务团队会在这里长出来」+ ghost 按钮「先派一个活」→ 聚焦派活入口（不新增硬编码 prompt）。

---

## 6. API 契约变更（保持单次 fetch）

`GET /api/cockpit/summary` 返回：

```
data: {
  payroll, invoices, business, obligations,   // 不变
  attention: AttentionItem[],                 // 替代 todos（Phase 1）
  recentWork: RecentWorkItem[],               // Phase 2
  team: TeamRoleItem[],                       // Phase 3
}
```

`todos` 字段随 TodosCard 一并移除；前后端同一 PR 内切换，无外部消费者。`business.source` 枚举扩展见 §4.3。

---

## 7. 布局与视觉规范

- 全部颜色经 tone/语义 token，无裸色值；新增 token 深浅两套齐全（§2.3）。
- 字阶用现有 `--text-*` 体系（`text-title` / `text-body` / `text-meta` 等），间距遵循 `spec-typography-spacing-system.md` 刻度；卡片样式对齐现存 cockpit 卡片（细边 + `--surface`），**不引入新的卡片形态**。
- 关注区 urgent 是全页唯一允许的动效热点（脉冲）；团队面板入场动效一次性播放，不循环。

---

## 8. 空态总表（争点 3 的落地）

| 区块 | 空态表现 | 引导动作 | 何时消失 |
|---|---|---|---|
| 关注区 | 收为一行：「当前没有需要你处理的事」+ 当前窗口建议一条（来自 cockpit-suggestions） | 建议文案本身可点击 → 预填派活入口 | 出现任一 attention 项 |
| 最近工作 | 「还没有工作记录」+「从派第一个活开始」 | 点击聚焦派活入口 | 第一次对话完成 |
| 团队面板 | 不渲染；槽位显示生长引导 mini-card（§5.3） | 聚焦派活入口 | 第一次 dispatch 落表 |
| 指标格 | 无数据显示「—」，**不显示 0 冒充**（应付/应收 0 笔是真实值，显示 0；未接入的数据才是「—」） | — | 数据落库 |
| 期间徽章 | 平峰不渲染 | — | 进入窗口期 |

冷启动第一天的完整首屏 = header（无徽章或有）+ 派活入口 + 关注区一行空态 + 指标条 + 合同收付空态（已有）+ 经营数据空态（已有）+ 生长引导卡 + 日历 + ComplianceStrip。页面诚实地「薄」，但每个空态都指向同一个动作：派活。

---

## 9. 红线对齐

| 红线 | 落点 |
|---|---|
| 3 数据信任链 | TrustBadge 推导矩阵；LLM 结论封顶「推测」；口述数据全链路标注（§4.3） |
| 4 「我不知道」 | 空态诚实显示「—」/「暂无」，禁止编造与 0 冒充 |
| 5 写操作审批 | 关注区动作只是对话入口，不新增任何绕过确认门的写路径 |
| 8 审计落点 | 本 spec 无新增写操作；gate 供给源只读 dispatches |

---

## 10. 验收标准

1. **死数据清除**：`quick-actions-card.tsx`、`todos-card.tsx` 删除；`app/cockpit/` 下 grep 不到硬编码 prompt 列表（引导文案仅存在于 `cockpit-suggestions.ts`）。
2. **推导矩阵单测**：`deriveTrustTier` 覆盖 4 来源 × 3 状态全部 12 格。
3. **关注区**：排序（urgent 先）、5 条折叠、空态一行、metric 第 4 格 count 一致且点击滚动——单测 + 组件测试（跑法遵循现有约定：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true`）。
4. **生长规则**：`team` 空 → 面板不渲染且引导卡渲染；非空 → 渲染；新增角色触发一次性入场动效（localStorage 断言）。
5. **徽章**：平峰不渲染；filing daysLeft=3 → alarm 色。
6. **深浅模式**：5 个新 token 在 `:root` 与 `.dark` 段均有定义（静态检查）。
7. **迁移幂等**：`business_metrics.source` 枚举迁移跑两次不报错，存量 `'agent'` 全部映射为 `user_dictated`。

---

## 11. 实施顺序

| Phase | 内容 | 依赖 | 回滚性 |
|---|---|---|---|
| 0 | 新 token + TrustBadge + deriveTrustTier + role-ui.ts | 无 | 纯增量，秒回滚 |
| 1 | 关注区（rule 源）+ 吸收 TodosCard + 删 QuickActions + 派活入口 + metric 第 4 格 | Phase 0 | 单 PR 内前后端同切 |
| 2 | 最近工作 + 期间徽章 + business_metrics.source 迁移与口述标签 | Phase 0 | 各自独立 |
| 3 | 团队面板 + gate 供给源 + 生长时刻 | spec-role-registry Phase 2 | 独立 |

---

## 12. 开放问题（不阻塞实施）

1. **ComplianceStrip 的归宿**：工资草稿数已被关注区覆盖一部分，观察使用后决定是否整条并入关注区。
2. **check_finding 供给源**：核查工具的异常清单目前死在对话文本里，需要「发现落表」机制（findings 表或复用 dispatches.summary 结构化），另起 spec。
3. **团队卡点击行为**：候选=展开该角色最近调度列表；等真实使用反馈。
4. **派活入口与全局搜索（Mod+G）的关系**：未来是否合并为命令面板，暂不动。
