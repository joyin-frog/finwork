# 智能体页 → 团队看板（agent-team-board）Spec

> 版本 v1.0 / 2026-07-05
> 状态：~~草案~~ → ~~已批准~~ → **已实施 + 真机验证**：实施审查抓出 1 阻塞（`listRoleLatestStatus` blocked 查询缺 `ended_at IS NULL`，已结束的 blocked 会永久污染分组）已修复 + C11 回归锁；测试 11/11 绿、typecheck 干净。真机 `/agents`：卡片网格 + 点卡开右侧抽屉（复用 usePreviewResize，含最近任务/数据权限/会做的活/放大关闭）均正常；等你拍板/在忙组当前为空=真实空闲态、与总览同源（同一 deriveAttentionItems + blocked）。已删被取代的原型 `app/dev/run-view`。（未提交，待随分支提交）
> **落地分支**：`1f1a992`（F1 子代理透明化 / F2 确认卡 / F4 薪税闭环 / 确认门修复）**已合入 main**（PR #33，main HEAD `28d3e3b`）。当前工作 worktree 已在此提交、这些底子都在——直接在当前分支实施即可。本功能复用 F1 的子代理事件流与确认门。
> 依赖：F1（子代理过程透明化，SSE 事件流）、F2/确认门修复（`ask_user` 确认卡）、现有 `app/agents/page.tsx` 花名册、`app/dev/run-view`（已验证的设计原型，作为视觉/交互参照）。
> 架构事实（写给全新上下文实现者）：
> - 现状：`app/agents/page.tsx` 是**静态花名册**——`AgentRow`（可展开行）+ `DispatchList`（懒加载派发台账），数据来自 `GET /api/agents`（roster）、`GET /api/agents/dispatches?roleId=`、`GET /api/agents/activity`、`POST /api/agents/toggle`。角色定义在 `lib/agent/roles/registry.ts`（`ROLE_REGISTRY`：id/name/charter/domain/available/skills/dataScope）；角色 UI tone 在 `lib/domain/role-ui.ts`（`ROLE_UI` → `--tone-payroll` 等，`ROLE_LABELS`）。
> - 派发数据：`lib/db/dispatch-store`（`DispatchRow`：roleId/label/summary/status/blockedReason/conversationId/startedAt）。`blockedReason != null` = 停在确认门。`status` 含 `running`/`success`/`failed`。
> - 确认门数据：`app/cockpit` 的 `AttentionSection` 已聚合"规则派生提醒（截止日）+ `listBlockedDispatches`（停在确认门）"——**本功能与它同源**。
> - 抽屉外壳复用：`app/shared/use-preview-resize.ts`（`usePreviewResize` → previewW/maximized/beginResize/mainRef，可拖宽+放大）；文件产物预览复用 `app/shared/file-preview-page.tsx`（`FilePreviewPage`，缩放/翻页/打开方式）。
> - 设计参照：`app/dev/run-view`（原型，dev-only）——等你拍板置顶 + 在忙/空闲动态分组 + 点卡进右侧抽屉。正式版照此，但接真实数据。
> - 测试栈：`npm test` = `node --import tsx tests/all.test.ts`（聚合，新文件须接入；含 AC6.2 把 typecheck 纳门禁）。**无 DOM 测试栈**：UI 用源码契约断言（`readFileSync`），纯逻辑用纯函数测试。

## 0. 目标与非目标

**目标**：把「智能体」页从静态花名册升级为**团队看板**——(1) 顶部「等你拍板」区（停在确认门 + 临近截止，可操作）；(2) 角色卡**动态分组**（在忙/待拍板置顶、空闲/未启用弱化下沉）；(3) 点卡片 → **右侧可拖宽/放大的抽屉**（复用 `usePreviewResize`），显该角色实时步骤 + 最近任务 + 数据权限 + 会做的活；(4) 任务的**文件产物** → 点开走现成 `FilePreviewPage`；(5) 与总览页**数据同源**、总览只留摘要+跳转。

**非目标（本期不做，已知并接受）**：
- ❌ 流动流程图 / 智能体间连线（已验证并行罕见，演示驱动，明确不做）。
- ❌ 抽"共享预览壳组件"重构（`<ResizablePreviewPanel>`）——**另立 spec**（跨 chat/知识库/文件工作面，独立 TDD + 逐页回归）。本期抽屉直接用 `usePreviewResize` + `FilePreviewPage`，不先抽壳。
- ❌ 可编辑工作流画布（会退化成 n8n/开发者工具，违背"对话即任务、把 AI 藏起来"）。
- ❌ 重建总览页——只把它的 team-panel/ticker 收敛成"摘要 + 跳转"，不搬整块看板。
- ❌ 用户手动"派活/编排"——派发仍由主对话的编排器决定，本页只读呈现 + 在确认门拍板。
- ❌ 引入 jsdom / 新依赖。

## 1. 成功标准

**A. 等你拍板区（数据同源，可操作）**
- [ ] 页顶渲染「等你拍板」：聚合 (a) `blockedReason != null` 的派发（停在确认门），(b) 临近截止（复用 cockpit/tax-calendar 的规则源）。与 cockpit `AttentionSection` **同一数据源**，不各算。验证：源码契约——两处都取自同一 store/domain 函数，无重复实现。
- [ ] 每条「停在确认门」有「去确认」入口 → 跳到对应 `conversationId` 会话（在那里由确认卡拍板）。验证：源码契约含跳转到 `/chat/recent?id=`。
- [ ] 无待办时区块降级为一句空态（不常驻空框）。

**B. 动态分组（纯函数可测）**
- [ ] `partitionRoles(rows)` 纯函数：按状态分「在忙·待拍板」（running 或 blocked）与「其他」（idle/available:false）；在忙组置顶，其他组弱化紧凑。验证：纯函数单测覆盖各状态归组 + 排序。
- [ ] 分组数量、角色 tone/名来自 `ROLE_UI`/`ROLE_LABELS`/`ROLE_REGISTRY`，不硬编码。

**C. 右侧抽屉（复用 usePreviewResize；源码契约 + 目视）**
- [ ] 点角色卡 → 右侧抽屉，**复用 `usePreviewResize`**（可拖宽、可放大铺满），不自造 resize 逻辑。验证：源码契约——抽屉组件 import 并使用 `usePreviewResize`（`beginResize`/`maximized`/`previewW`）。
- [ ] 抽屉内容：最近任务（`/api/agents/dispatches`）+ 数据权限 + 会做的活（`ROLE_REGISTRY`）+ running 状态标识。**"实时步骤"见 §1.E 的边界——不是真·SSE 实时**（F1 事件绑在单次对话 SSE 上，无按 roleId 订阅的端点，非对话页接不进）；MVP 只显 running 状态 + 最近派发摘要快照，不逐步流式。
- [ ] 任务的**文件产物**（`finalize_deliverable` 声明的文件）→ 点开渲染 `FilePreviewPage`（复用，不重写）。验证：源码契约含 `FilePreviewPage` 引用。
- [ ] 敏感：抽屉/卡片不显身份证/卡号（本就无）；实时步骤复用 F1 已脱敏的 `getToolSummary` 摘要，不引原始 input/output。

**D. 与总览同源 + 不回归**
- [ ] cockpit 的 team-panel/ticker 收敛为"摘要 + 跳转 `/agents`"；「等你拍板」摘要数字与本页一致（同源）。验证：源码契约 + 数量一致性断言。
- [ ] 现有 `/api/agents*`、toggle、DispatchList 行为不破；全套测试 + typecheck 绿。

**E. 实时状态（MVP 边界）**
- [ ] running 状态：MVP 用**进入页面/切回窗口时重取 + 轻量轮询**（如 5-10s，仅在有 running 派发时）。**F1 的子代理 SSE 接不进本页**（它绑在单次对话请求的 ReadableStream 上，无按 roleId 订阅的端点、`chat_agent_events` 按 message_id 存不按 role_id）——所以**不做**真·实时步骤流；要显步骤只能轮询 `chat_agent_events` 快照，成本另算，本期不做。**不要求**常驻 WebSocket。MVP 只保证"打开/切回时状态是新的"。

## 2. Files touched（实施时以分支实际为准校正）

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/domain/agent-board.ts` | 新增 | 纯函数 `partitionRoles` + 「等你拍板」聚合的纯整形（输入 dispatch/attention 数据，输出分组 + 待办列表），无 DB/IO。 |
| `app/agents/page.tsx` | 修改 | 花名册 → 团队看板：顶部等你拍板区 + 动态分组卡片 + 选中打开抽屉。保留 toggle/权限逻辑。 |
| `app/agents/agent-card.tsx` | 新增 | 角色卡（tone 头像 + charter + 本月N次·最近 + 状态 pill；紧凑/常规两态）。 |
| `app/agents/agent-detail-drawer.tsx` | 新增 | 右侧抽屉：复用 `usePreviewResize` 外壳；内容=实时步骤+最近任务+数据权限+会做的活；文件产物开 `FilePreviewPage`。 |
| `app/agents/attention-panel.tsx` | 新增 | 等你拍板区（与 cockpit `AttentionSection` 同源，抽公共取数）。 |
| `lib/agent`/`app/api/agents/route.ts`（server 端） | 修改 | **同源正解（评审）**：`lib/domain/attention.ts` 已有 `deriveAttentionItems`/`blockedDispatchToAttentionItem`/`sortAttentionItems`（纯函数），cockpit 的 `/api/cockpit/summary` 已 server 端调它们。本页也**在 server 端（/api/agents 或新端点）复用这同一套 domain 函数**产出等你拍板数据——**不要在 client 直调 `deriveAttentionItems`**（它依赖 `PayrollPeriodSummary` 等 DB 调用，client 调不了）。两页同源 = 两个 API 都用同一批 domain 函数，不是 client 共享。 |
| `app/api/agents/route.ts` | **必改** | 现响应（:55-66）只到 dispatchCount/lastAt，**缺 status/blockedReason/lastSummary**。必须补：`status`（该角色最新派发是否 running——查 `subagent_dispatches` status='running' 最新行）、`blockedReason`（是否停在确认门）、`lastSummary`。不补则分组的"在忙"组永远空。 |
| `lib/db/dispatch-store` | 修改 | `listRoleDispatchSummary()` 现只回 count/lastAt/lastSummary；补 running/blocked 状态查询（或新增一个按 roleId 取最新派发状态的函数）供 route 用。 |
| `app/cockpit/*`（team-panel/ticker） | 修改 | 收敛为摘要 + 跳转 `/agents`，删除重复的整块看板渲染。**保留冷启动态 `team-growth-hint.tsx`**（cockpit/page.tsx:93 team 为空时渲染它）——别一并删掉。 |
| `tests/agent-board.test.ts` | 新增 | 纯函数（partitionRoles/待办聚合）+ 源码契约（抽屉用 usePreviewResize、文件产物用 FilePreviewPage、两页同源、去确认跳转、脱敏）。接入 `tests/all.test.ts`。 |
| `tests/all.test.ts` | 修改 | 接入 `agentBoardTestPromise`。 |

## 3. 实施步骤

1. **纯函数 `agent-board.ts`**：`partitionRoles(roster, dispatches)` → `{ active: RoleCard[]; rest: RoleCard[]; attention: AttentionItem[] }`。active = running 或 有 blocked 派发；rest = 其余（含 available:false 置最后）。attention = blocked 派发（带 conversationId）+ 临近截止（传入的 calendar/attention 源）。先写测试（§4.1）再实现。
2. **等你拍板同源**：若 cockpit 的 attention 取数在组件内联，抽成 `lib/domain` 共享函数；两页都调它。`attention-panel.tsx` 渲染 + 「去确认」跳 `/chat/recent?id=`。
3. **卡片 + 分组**：`agent-card.tsx`（照原型：tone 头像/charter/stats/状态 pill）；`page.tsx` 用 `partitionRoles` 渲染两组。
4. **右侧抽屉**：`agent-detail-drawer.tsx` **复用 `usePreviewResize`**（container 挂 `mainRef`、分隔条 `onMouseDown={beginResize}`、宽度用 `previewW`、放大用 `maximized`）。**关键参数（评审 P2）**：`usePreviewResize(listMinW)` 的 `listMinW` 须按卡片网格最小可接受宽设**≥400**（默认 300 太小，抽屉会盖住卡片；参照 files 页传 460、knowledge 传 360）；**maximized 时左侧卡片网格 `hidden`（抽屉全屏、卡片消失）是既有语义、本功能预期如此**（照 `app/files/page.tsx:474` 的 `maximized && "hidden"`）。内容分区（最近任务/数据权限/会做的活 + running 状态，不做实时步骤流）；文件产物用 `<FilePreviewPage>`。参照 `app/files/page.tsx` / `app/knowledge/page.tsx` 的既有接法。
5. **总览收敛**：cockpit team-panel/ticker 改为摘要 + 跳转；确保「等你拍板」数字两页一致（同源）。
6. **实时状态**：MVP——页面进入/`visibilitychange` 重取；running 步骤若能复用 F1 的 SSE（页面订阅 agent 事件）则接，否则轮询。标注边界。
7. 测试（§4）。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npm run typecheck
```
- 新增测试（`tests/agent-board.test.ts`，接入 `all.test.ts`）：
  1. 纯函数：`partitionRoles` 各状态归组 + 排序（在忙置顶、available:false 置尾）；attention 聚合含 blocked 的 conversationId + 截止项；空态。
  2. 源码契约（`readFileSync`）：抽屉 import/用 `usePreviewResize`；文件产物用 `FilePreviewPage`；「去确认」含 `/chat/recent?id=`；等你拍板与 cockpit 同源（同一 domain 函数）；卡片/抽屉不含身份证/卡号字段、实时步骤走 `getToolSummary`。
- 真机目视（交付证据）：`preview_start` → `/agents` → 看等你拍板/分组/点卡开抽屉/拖宽/放大/打开一个文件产物。跑不动 audit 标"待人工目视"。
- 回归：现有 agents/cockpit/files/knowledge 页不破。

## 5. 风险与开放问题

- **落地分支**：必须在 `claude/fervent-northcutt-84a8ff`（含 F1/F2/F4）。环境 worktree 有并发切换史——实施前先确认 worktree 稳定切到该分支，否则会建到缺底子的 main。
- **实时状态的真价值 vs 成本**：真·实时推送（running 步骤秒级更新）需要页面订阅 F1 SSE 或轮询，成本不低。MVP 只做"打开/切回是新的"，先验证用户是否真需要盯着看（多半不需要，符合"财务不盯屏"）。别过早上 WebSocket。
- **同源纪律（红线 3 相关）**：等你拍板/状态数字必须与 cockpit、与派发台账同源，否则两处数字打架会毁信任。抽公共取数是硬要求。
- **抽屉 ≠ 文件预览**：抽屉装状态/任务（不缩放），文件产物才走 `FilePreviewPage`（缩放/翻页）。别把两者混成一个组件（那是后续"抽壳"重构的事，不在本期）。
- **不做连线**：若评审/实现中有人想加流动连线，回到本 spec 非目标——并行罕见、演示驱动，明确不做。
- **开放问题**：`/api/agents` 现有响应是否已含 status/blockedReason/最近摘要？实施第一步先核，缺则补（列入本 spec 的 route 改动）；已够则不动 route。

---

## 附录：audit（`docs/spec/audit-agent-team-board.md`）
Files changed（对照 §2）→ §1 逐条核对（命令+结果+目视）→ 测试/typecheck 输出 → 同源/脱敏/复用（usePreviewResize+FilePreviewPage）自查 → 偏离/遗留/风险。
