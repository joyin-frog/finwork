# 本月任务看板 Spec

> 版本 v1.1 / 2026-07-07
> 状态：已实施（计划批判 fix first→修正；实施审查裁决 ship，2026-07-07；audit 见 audit-task-board.md；审查后清理：删除 counts 死代码防御环）
> 依赖：`spec-task-templates.md`（已实施：任务模板 + 派发对象化五列 + pending/locked 状态机）、`spec-agent-team-board.md`（/agents 页现状）
> 架构事实（写给没读过代码库的人）：
> - `app/agents/page.tsx` 是 `"use client"` 客户端组件，数据来自 `fetch("/api/agents")`（62 行附近），返回 `{ ok, data: { roster, attention } }`；页面无现成 Tab 机制，只有固定两个 section（在忙·待拍板 / 其他）。
> - `app/api/agents/route.ts`（约 136 行返回 payload）组装 roster + attention。
> - 任务模板在 `lib/agent/roles/task-templates.ts`：`TaskTemplate { id, roleId, name, description, mode: "subagent"|"main-skill", skillName?, needsFiles?, objectLabel?, promptTemplate? }`，共 5 条：month-close-precheck（记账）、payroll-review（薪税）、filing-precheck（税务，**main-skill 型**）、bank-recon（资金）、dunning-list（往来）。
> - **main-skill 型模板经主对话技能执行，不产生 `subagent_dispatches` 行**——看板对它没有进度数据，这是本 spec 必须显式处理的事实。
> - `lib/db/dispatch-store.ts` 的 `DispatchRow`（199-213 行）：`id, roleId, label, summary, status("running"|"success"|"failed"), blockedReason, conversationId, startedAt, endedAt, taskTemplateId, businessObject, period("YYYY-MM"|null), reviewStatus("pending"|"locked"|null)`。**尚无按 period 查询的函数**。
> - `blocked_reason` 与 status 独立（success 行也可能有）；blocked 行必然已 ended。reviewStatus 只在 status='success' 时为 'pending'，人锁定后 'locked'（CAS 只进不退）。锁定按钮在 `app/agents/agent-detail-drawer.tsx`（46-56 行：`POST /api/agents/dispatches/${id}/lock` + `lockedIds: Set<number>` 乐观更新）。
> - 会话深链形式：`/chat/recent?id=<conversationId>`（agent-detail-drawer.tsx:161 既有写法）。
> - 派活 href 拼法在 `app/agents/agent-card.tsx`：subagent 型 `/chat/new?prompt=让${name}执行「${t.name}」，期间 ${period}…`（166-168 行），main-skill 型 `/chat/new?skill=${skillName}`（164-165 行）；`currentYearMonth()`（133-138 行，本地时区）**未导出**。
> - 轻量分段切换样式参照 `app/shared/resource-tabs.tsx`（Link 版；看板切换是页内 state，需仿其样式做 state 版）。
> - `lib/domain/` 纯函数模块 + `tests/<模块名>.test.ts`（node:assert，聚合进 `tests/all.test.ts`）；UI 无 DOM 测试栈，用"源码契约断言"（readFileSync 搜字符串）。测试命令须带 `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true`。

## 0. 目标与非目标

**目标**：`/agents` 页新增「本月任务」看板视图：按 5 个任务模板分区（对应月度日历焦虑节点），当月（`period = 当月`）派发记录渲染为对象卡片（状态 pill + 异常红字 + 会话深链），节点级例外式汇总，未跑过的节点显式"未开始"。让用户月中扫一眼知道"哪些事跑完了、哪些卡在人身上、哪些还没动"。

**非目标（本期不做，已知并接受）**：
- 看板上的任何处理动作（锁定按钮、重跑按钮）——铁律"看板只展示和深链"；锁定继续在角色详情抽屉操作。
- 历史月份回溯、自定义节点、拖拽排序。
- 一键批跑（功能 4）。
- main-skill 型模板（filing-precheck）的进度跟踪——主对话技能执行不落派发行，看板对其只给入口不给状态（显式标注，不伪造"未开始"）。
- cockpit 总览页不动（TeamPanel 集成留给后续）。
- 卡片上的业务数字展示（派发行没有结构化数字，不硬造）。

## 1. 成功标准

- [ ] `lib/domain/task-board.ts` 纯函数 `deriveTaskBoard(templates, dispatches, period)`：
  - 卡片状态推导优先级 `running > locked > blocked(blockedReason≠null) > failed > pending`——**locked 排在 blocked 之前**：锁定是人工终审终态，人拍板即视为连同确认门拦截一并处理完毕；单测逐档覆盖，含 success+blockedReason+locked 行归 locked、success+blockedReason（未锁）归 blocked、旧数据（reviewStatus=NULL 且 success）兜底归 pending 的边界；
  - 节点内卡片按 startedAt 降序；节点计数 `counts: Partial<Record<TaskBoardCardState, number>>` 只含非零项（例外式的稀疏性在类型层表达）；
  - 无当月派发的 subagent 型节点 `kind:"empty"` 且带派活 href；main-skill 型节点恒为 `kind:"manual"` 带技能入口 href——两者单测覆盖。
- [ ] `listDispatchesForPeriod(period)` 只返回 `period` 精确匹配的行（NULL 不出现），startedAt 降序——store 测试覆盖。
- [ ] `GET /api/agents` payload 新增 `board`（含 period 与 5 个节点），既有 roster/attention 字段不变——**task-board.test.ts 里对 `app/api/agents/route.ts` 做源码契约断言（含 `deriveTaskBoard` 与 `listDispatchesForPeriod` 两个调用名），防止漏做 API 步骤时测试全绿**。
- [ ] `/agents` 页顶部分段切换「团队 / 本月任务」，默认团队视图，切换纯客户端 state，不改 URL；看板视图渲染节点分区 + 卡片，卡片深链 `/chat/recent?id=…`。
- [ ] 源码契约断言：`app/agents/task-board.tsx` 不含 `fetch(`（看板零动作铁律的机械守卫），且不触发既有 T4h 角色名字面量守卫。
- [ ] `currentYearMonth` 与两种模板 href 拼接收敛为共享 helper（`task-templates.ts` 导出），`agent-card.tsx` 改为复用，行为不变（现有测试不破）。
- [ ] 全量测试跑绿 + `npx tsc --noEmit` 干净：`source .venv/bin/activate && FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/domain/task-board.ts` | 新增 | TaskBoard/TaskBoardNode/TaskBoardCard 类型 + `deriveTaskBoard` 纯函数 |
| `lib/db/dispatch-store.ts` | 修改 | 新增 `listDispatchesForPeriod(period: string): DispatchRow[]` |
| `lib/agent/roles/task-templates.ts` | 修改 | 导出 `currentYearMonth()` 与 `buildTemplateDispatchHref(template, roleName, period)`（从 agent-card 迁入的纯字符串函数） |
| `app/agents/agent-card.tsx` | 修改 | 删本地 `currentYearMonth` 与 href 拼接，改用共享 helper（行为不变） |
| `app/api/agents/route.ts` | 修改 | payload 增 `board: deriveTaskBoard(TASK_TEMPLATES, listDispatchesForPeriod(当月), 当月)` |
| `app/agents/task-board.tsx` | 新增 | 看板视图组件（纯展示 + Link 深链，无 fetch/无动作） |
| `app/agents/page.tsx` | 修改 | 分段切换 state + 条件渲染看板/团队两视图 |
| `tests/task-board.test.ts` | 新增 | deriveTaskBoard 全部分支 + task-board.tsx 源码契约断言 |
| `tests/subagent-dispatches.test.ts` | 修改 | 追加 listDispatchesForPeriod 测试 |
| `tests/all.test.ts` | 修改 | 注册 tests/task-board.test.ts |

## 3. 实施步骤

1. **共享 helper** `lib/agent/roles/task-templates.ts`：把 `agent-card.tsx:133-138` 的 `currentYearMonth()`（保持本地时区实现）与 164-168 行的 href 拼接逻辑迁为导出函数：
   ```ts
   export function currentYearMonth(d = new Date()): string   // 可注入 Date：API route 传它已有的 now，同一响应内口径一致
   export function buildTemplateDispatchHref(t: TaskTemplate, roleName: string, period: string): string
   // main-skill → /chat/new?skill=...；subagent → /chat/new?prompt=...（编码与现实现逐字符一致）
   ```
   `agent-card.tsx` 改为 import 复用（无参调用）；不改任何生成结果（现有 UI 行为与测试不变）。
2. **store 读函数** `lib/db/dispatch-store.ts`：`listDispatchesForPeriod(period)`——SELECT 与 `listDispatchesByRole` 同列集，`WHERE period = ? ORDER BY started_at DESC, id DESC`，复用现有 row→DispatchRow 映射写法。
3. **领域模型** `lib/domain/task-board.ts`：
   ```ts
   export type TaskBoardCardState = "running" | "blocked" | "failed" | "locked" | "pending";
   export type TaskBoardCard = {
     dispatchId: number; objectLabel: string;      // businessObject ?? template.objectLabel ?? label ?? "未命名任务"
     state: TaskBoardCardState; summary: string | null;
     blockedReason: string | null; conversationId: string | null;
     startedAt: string | null;
   };
   export type TaskBoardNode =
     | { kind: "cards"; templateId: string; templateName: string; roleId: string; roleName: string;
         cards: TaskBoardCard[]; counts: Partial<Record<TaskBoardCardState, number>> }
     | { kind: "empty"; templateId: string; templateName: string; roleId: string; roleName: string; startHref: string }
     | { kind: "manual"; templateId: string; templateName: string; roleId: string; roleName: string; startHref: string; note: string };
   export type TaskBoard = { period: string; nodes: TaskBoardNode[] };
   export function deriveTaskBoard(templates: TaskTemplate[], dispatches: DispatchRow[], period: string): TaskBoard
   ```
   推导规则：
   - 节点顺序 = TASK_TEMPLATES 声明顺序（即月度节奏顺序）；roleName 经 `getRoleDefinition(roleId)?.name ?? roleId`；
   - main-skill 型模板恒为 `kind:"manual"`，note 固定文案"在主对话执行，看板暂不跟踪进度"，startHref 用共享 helper；
   - subagent 型：按 `taskTemplateId === t.id` 过滤入参 dispatches（入参已限当月），空则 `kind:"empty"`（startHref 同派活菜单）；
   - 卡片状态优先级：`status==='running'` → running；`reviewStatus==='locked'` → locked（人工终审终态，优先于 blocked——拍板即视为连拦截一并处理完）；`blockedReason != null` → blocked；`status==='failed'` → failed；其余（success，含 reviewStatus=NULL 旧行）→ pending；
   - counts 只写非零项；**汇总文案（headline）不在 domain 层拼**——中文展示措辞由 UI 组件从 counts 组装（顺序 blocked → running → pending → failed → locked），domain 保持纯数据；
   - 纯函数：不 import store、不读时钟（period 由调用方传入——`Date` 不进 domain 层，方便测试）。
4. **API** `app/api/agents/route.ts`：组装 payload 处增 `board`——`const period = currentYearMonth(now)`（**复用该 route 约 23 行已有的 `const now = new Date()`**，保证同一响应内财税统计与看板月份口径一致）；`deriveTaskBoard(TASK_TEMPLATES, listDispatchesForPeriod(period), period)`。roster/attention 组装逻辑零改动。
5. **看板组件** `app/agents/task-board.tsx`：`"use client"`，props 接 `board: TaskBoard`。**注意既有守卫 `tests/agents-space.test.ts` T4h**：递归扫描 `app/agents/` 断言不得出现任何角色中文名字面量（「记账专员」等）——组件内一切名称必须来自 board 数据，连注释都不能写角色名。结构：顶部一行全局汇总（各节点 counts 聚合，例外优先措辞，中文文案在此组装）；每节点一个分区（模板名 + 角色名 + 由 counts 组装的汇总句），内为卡片列表——状态 pill（复用 agent-card 现有 pill 的样式 token）、objectLabel、summary 截断一行、blocked 卡红字 blockedReason、locked 卡锁标 🔒、整卡或"查看"链接 `/chat/recent?id=…`（conversationId 为 null 则不渲染链接）；empty 节点渲染"未开始 + 去派活"Link；manual 节点渲染 note + "去执行"Link。**组件内禁止 fetch/mutation**，全部交互都是 `<Link>`。样式围绕 `app/globals.css` token，参照 attention-panel/agent-card 既有写法，不引新依赖。
6. **页面切换** `app/agents/page.tsx`：`useState<"team"|"board">("team")`，顶部仿 `app/shared/resource-tabs.tsx` 样式做 state 版分段切换（两个 button，当前项重色）；`/api/agents` 返回的 `board` 存 state，切到看板时渲染 `<TaskBoard>`。团队视图 JSX 不动。
7. **测试**：
   - `tests/task-board.test.ts`：deriveTaskBoard——五档状态优先级各一例、success+blockedReason+locked→locked、success+blockedReason（未锁）→blocked、reviewStatus NULL+success→pending、排序、counts 无零值键、empty/manual 节点、startHref 与 buildTemplateDispatchHref 一致；源码契约：readFileSync 断言 ① task-board.tsx 无 `fetch(`（不做 "POST" 字符串断言——注释/死代码误伤风险大于收益）且含 `/chat/recent?id=`，② **route.ts 含 `deriveTaskBoard(` 与 `listDispatchesForPeriod(`**（B1 守卫：漏做 API 步骤时测试必红）；
   - `tests/subagent-dispatches.test.ts` 追加：两行不同 period + 一行 NULL period，`listDispatchesForPeriod` 只回匹配行且降序；
   - `tests/all.test.ts` 注册新文件。

## 4. 测试与验证方式

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/competent-thompson-d4dd37
source .venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npx tsc --noEmit
```

- 明确不需要：e2e / DOM 渲染测试（仓库无此设施，UI 靠源码契约断言）；cockpit 相关测试不动。

## 5. 风险与开放问题

- **看板无锁定按钮的体验取舍**：待锁定卡片只能深链回对话/去抽屉锁定，月末集中拍板会多几次点击。这是"看板零动作"铁律下的有意取舍；若真机用起来太绕，放开"锁定=轻量拍板动作进看板"须回到产品层重新拍板，不在本 spec 内偷放。
- **manual 节点（filing-precheck）永远没有进度**：诚实标注优于伪造状态；跟踪主对话技能执行需要新的落表机制，属功能 4 或独立决策。
- **`/api/agents` payload 变大**：board 随每次轮询携带；当月派发量级（十数条）下可忽略，不做分端点。
- **看板与"等你拍板"的时间窗不对称（有意）**：attention/blocked 走 7 天窗口，看板走"当月 period 全量"——20 天前的 blocked 派发会出现在看板（月度日历视角）但不在 attention（近期动态视角）。两者定位不同，不强行同步；用户从看板卡片深链回对话即可处理。
- **agent-card href 重构等价性**：helper 迁移必须逐字符保持 URL 生成一致，reviewer 请比对新旧拼接代码；现有 agent-card 相关测试（若有源码契约断言涉及 href）是守卫。
