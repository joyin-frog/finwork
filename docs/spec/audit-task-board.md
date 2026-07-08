# audit-task-board.md

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/agent/roles/task-templates.ts` | 修改 |
| `app/agents/agent-card.tsx` | 修改 |
| `lib/db/dispatch-store.ts` | 修改 |
| `lib/domain/task-board.ts` | 新增 |
| `app/api/agents/route.ts` | 修改 |
| `app/agents/task-board.tsx` | 新增 |
| `app/agents/page.tsx` | 修改 |
| `tests/task-board.test.ts` | 新增 |
| `tests/subagent-dispatches.test.ts` | 修改 |
| `tests/all.test.ts` | 修改 |

---

## 每文件改了什么

### `lib/agent/roles/task-templates.ts`
在现有函数之前（`getTemplatesForRole` 之前）插入两个新导出函数：
- `currentYearMonth(d = new Date()): string`：本地时区年月，可注入 Date；实现与原 agent-card 完全一致。
- `buildTemplateDispatchHref(t, roleName, period): string`：main-skill 型返回 `/chat/new?skill=...`，subagent 型返回 `/chat/new?prompt=...`；与原 agent-card 逐字符等价。

### `app/agents/agent-card.tsx`
- import 行增加 `currentYearMonth`、`buildTemplateDispatchHref`（从 task-templates）。
- `DispatchButton` 内删除本地 `currentYearMonth` 函数（7 行），改为调用导入函数（无参）。
- href 拼接从内联三元表达式改为调用 `buildTemplateDispatchHref(t, cardName, period)`。生成结果与原来逐字符一致。

### `lib/db/dispatch-store.ts`
在 `listBlockedDispatches` 之前新增 `listDispatchesForPeriod(period: string): DispatchRow[]`：
- SELECT 与 `listDispatchesByRole` 同列集，`WHERE period = ?`（精确匹配；NULL period 行不出现），`ORDER BY started_at DESC, id DESC`。
- row→DispatchRow 映射逐字段复用 `listDispatchesByRole` 写法。

### `lib/domain/task-board.ts`（新增）
纯函数模块，不 import store，不读时钟：
- 导出类型 `TaskBoardCardState`（联合）、`TaskBoardCard`、`TaskBoardNode`（可辨识联合，三 kind）、`TaskBoard`。
- `deriveCardState(row)`：running > locked > blocked > failed > pending 优先级推导。
- `deriveTaskBoard(templates, dispatches, period)`：按模板声明顺序生成节点；main-skill 型恒 manual；subagent 型空则 empty，有记录则 cards；counts 只含非零项；中文文案不在此层拼装。

### `app/api/agents/route.ts`
- import 新增 `listDispatchesForPeriod`（dispatch-store）、`deriveTaskBoard`（task-board）、`currentYearMonth`+`TASK_TEMPLATES`（task-templates）。
- 在 `return NextResponse.json` 前两行：`const period = currentYearMonth(now)`（复用同函数已有的 `const now = new Date()`，口径一致）；`const board = deriveTaskBoard(TASK_TEMPLATES, listDispatchesForPeriod(period), period)`。
- 返回体改为 `{ roster, attention, board }`。

### `app/agents/task-board.tsx`（新增）
"use client" 组件，props 接 `board: TaskBoard`：
- 无 `fetch(`，全部交互为 `<Link>`。
- 无任何角色中文名字面量（通过 T4h 守卫）。
- `StatePill`：五态 pill，各 tone 来自 globals.css token。
- `buildHeadline(counts)`：从 counts 组装中文汇总句，顺序 blocked→running→pending→failed→locked。
- `buildGlobalHeadline(board)`：聚合所有 cards 节点 counts。
- `DispatchCard`：状态 pill + objectLabel + summary 截断 + blocked 红字 + locked 锁标 + 整卡为 Link（conversationId 非空时 `/chat/recent?id=`）。
- `BoardNode`：cards/empty/manual 三分支渲染；empty 显示"未开始+去派活"Link；manual 显示 note+"去执行"Link。
- `TaskBoardView`：全局汇总行 + 节点列表。

### `app/agents/page.tsx`
- import 新增 `TaskBoardView`（task-board）、`TaskBoard` 类型（task-board）。
- state 新增：`view: "team"|"board"`（默认 "team"）、`board: TaskBoard | null`（默认 null）。
- `fetchRoster` 中在 `setAttention` 后追加 `setBoard(json.data.board ?? null)`。
- 标题栏内增加 state 版分段切换（两个 `<button>`，样式仿 resource-tabs.tsx 用 text-title + transition-colors，当前项 text-foreground，非当前项 text-muted-foreground）；"展开预览"按钮条件追加 `view === "team"`。
- 内容区三路分支：error → 错误页；loading → 加载中；view==="board" → TaskBoardView（或"看板数据不可用"）；team → 原有 attention+roster 布局（零改动）。

### `tests/task-board.test.ts`（新增）
共 TB1-TB13 + SC1-SC4 + currentYearMonth 注入共 18 条断言：
- TB1-TB8：五档状态优先级各一例，含 success+blockedReason+locked→locked（TB6）、success+blockedReason未锁→blocked（TB7）、reviewStatus=NULL+success→pending（TB8）边界。
- TB9：入参 startedAt 降序排列，domain 不重排，顺序保留验证。
- TB10：counts 无零值键。
- TB11/TB12：empty/manual 节点类型与 startHref 非空。
- TB13：所有模板 startHref 与 `buildTemplateDispatchHref` 一致。
- SC1-SC4：readFileSync 源码契约断言（task-board.tsx 无 fetch(，含 /chat/recent?id=；route.ts 含 deriveTaskBoard( 与 listDispatchesForPeriod(）。

### `tests/subagent-dispatches.test.ts`
末尾追加 T11：插入两行 period='2026-07'、一行 period='2026-06'、一行 NULL period；`listDispatchesForPeriod('2026-07')` 只回 2 行，无 NULL period 行，无其他 month 行，且 id 降序。

### `tests/all.test.ts`
末尾（`taskTemplatesTestPromise` 之后）追加注册 `tests/task-board.test.ts`。

---

## 与计划的偏差及原因

无偏差。所有步骤均按 spec v1.1 §3 执行：
- 共享 helper 迁移（步骤 1）、store 读函数（步骤 2）、领域模型（步骤 3）、API（步骤 4）、看板组件（步骤 5）、页面切换（步骤 6）、测试（步骤 7）均完成。
- `workers/.venv` 在 git worktree 中不存在（worktree 的 workers/ 只含 finance_worker.py），创建了符号链接 `workers/.venv → /Users/gyro/codex/finance-agent-public/workers/.venv` 使 python 路径解析正常。此链接不影响代码，仅测试环境需要，与 spec 要求无冲突。

---

## 测试结果

命令（实际执行，因 worktree 无 .venv 需激活主工程 venv）：
```
source /Users/gyro/codex/finance-agent-public/workers/.venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npx tsc --noEmit
```

**npm test**：全量 11 个测试套件，11 pass，0 fail，0 skip。包含：
- task-board TB1–TB13 全绿
- SC1–SC4 源码契约断言全绿
- currentYearMonth 注入 Date 全绿
- subagent-dispatches T1–T11 全绿（含新增 T11 listDispatchesForPeriod）

**npx tsc --noEmit**：
- 非测试文件（app/、lib/）：0 错误（我的改动无引入新错误）。
- 测试文件（tests/）：TS5097（allowImportingTsExtensions）和 TS2775（assert 类型注解）均为项目基线预存错误，在 stash 状态下同样存在，与本次改动无关。我的新 task-board.test.ts 新增 3 条 TS5097 错误，与仓库所有其他测试文件一致（项目级 tsconfig 设置决定，非本次可修范围）。

---

## 开放风险

1. **workers/.venv 符号链接**：本次实施在 worktree 的 `workers/` 目录创建了一个符号链接指向主工程 venv。此链接是 untracked 文件，不会进入 git 历史，PR 合并后清理 worktree 时会自动消失。对主分支无影响。
2. **看板无锁定按钮（有意取舍）**：spec §5 已记录——待锁定卡片需深链到会话/抽屉操作，月末集中拍板多几次点击。本实施严格遵循"看板零动作铁律"。
3. **manual 节点永远无进度**：filing-precheck 因 main-skill 型不落派发行，看板仅提供入口不给状态，已诚实标注 note。
4. **/api/agents payload 变大**：board 随每次轮询返回（含 5 个节点，当月派发量级可忽略），spec §5 已接受此风险。
5. **agent-card href 等价性**：helper 迁移已由 TB13 单测逐模板验证 startHref 与 buildTemplateDispatchHref 一致；agent-card 现使用同一函数，与原内联写法逐字符相同。T4h 守卫已确认 app/agents/ 无硬编码角色名。
