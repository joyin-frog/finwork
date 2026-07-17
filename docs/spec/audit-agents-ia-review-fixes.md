# Audit — agents-ia-review-fixes

## Files changed

- `app/agents/[roleId]/workspace-work-tab.tsx`
- `lib/db/dispatch-store.ts`
- `app/api/agents/route.ts`
- `app/shared/nav-state.tsx`
- `app/shared/app-nav.tsx`
- `app/agents/[roleId]/page.tsx`

## 每个 bug 怎么修的

### A. Codex P1 — TaskPreview 切任务残留

`workspace-work-tab.tsx`：`<TaskPreview key={selected.id} ... />` 加 key，切换选中任务时组件被重新挂载，`filePreview`/`locking`/`locked` 内部态不再跨行残留。

### B. Codex P2 — failed 不当「已交付」

`workspace-work-tab.tsx`：

- `TaskGroupKey` 增加 `"failed"`；`TASK_GROUPS` 顺序改为 等你拍板 → 进行中 → 失败 → 已交付。
- `groupOf`：`row.status === "failed"` 单独分到 `"failed"` 组（在 pending/running 判断之后，done 兜底之前）。
- `TaskRow`：新增 `failed` 判定，失败态用 `--tone-alarm` 描边色 + 「失败」标签。
- `TaskPreview`：新增 `failed` 判定与独立展示区块（标题「任务失败」+ 摘要 + 查看会话，走 `--tone-alarm`），不写「已完成」；原「已交付且无文件」兜底分支加 `!failed` 排除，避免失败态落入该分支显示「已完成」文案。文件产物区块保持对任何态生效（失败态若有文件仍展示）。

### C. Codex P2 — 侧栏徽标漏计 review-pending

1. `lib/db/dispatch-store.ts` `RoleLatestStatus` 增加 `hasReviewPending: boolean`；`listRoleLatestStatus` 内新增查询：`role_id = ? AND review_status = 'pending' AND ended_at >= datetime('now', '-7 days')`，与既有 blocked 查询同源窗口（近 7 天）。未改动原有 blocked 查询文本（保留 `tests/agent-board.test.ts` C11 的源码字符串断言区间）。
2. `app/api/agents/route.ts` roster 条目增加 `reviewPending: latestStatus?.hasReviewPending ?? false`。
3. `app/shared/nav-state.tsx`：`AgentRosterLite` 加 `reviewPending: boolean`；`fetchAgentRoster` map 时带上该字段（默认 `false`）；`agentPendingCount` 改为 `blockedReason 非空 || reviewPending`；更新相关注释。
4. `app/shared/app-nav.tsx` `renderRoleRow`：入参类型加 `reviewPending: boolean`；`isBlocked` 改为 `(blockedReason 非空) || reviewPending`，状态点与「待拍板」tag 随之同步。

### D. 先前 review P0

1. `WorkspaceWorkTab`：新增 `roleId` 变化 effect，重置 `initializedRef.current = false` 与 `setSelectedId(null)`；`fetchDispatches` 加请求令牌（`requestTokenRef` 递增，响应到达时比对令牌，过期响应丢弃），避免切角色时的竞态覆盖。
2. `app/agents/[roleId]/page.tsx`：
   - `ProfileTabView` 加 `key={role.roleId}`，角色切换时组件重新挂载，`disabledOverride` 乐观态不再残留。
   - `fetchRole` 同样加请求令牌（`requestTokenRef`）+ `fetch(..., { cache: "no-store" })`。
   - `RoleDetail` 类型加 `reviewPending: boolean`；header/`isBlocked` 改为 `(blockedReason 非空) || reviewPending`，与侧栏口径一致。

## 不要做（已遵守）

- 未改 F3 应用标签分 key。
- 未删旧 `/agents` 页、未改 cockpit 链接。
- 未改 CLAUDE.md / graphify-out 大文件（仅 `graphify update .` 产生的常规重建）。
- 未 commit。

## 测试结果

worktree 内运行（`/Users/gyro/codex/finance-agent-public/.claude/worktrees/confident-williamson-02801b`）：

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx --test tests/agent-board.test.ts tests/nav-v3.test.ts
```
→ 2/2 通过（agent-board 全部 B1–B7/C1–C11 绿；nav-v3 JOY-10 + C5–C7 绿，含 C11「blocked 查询按近期窗口过滤」未受新查询影响）。

附加回归（未在需求中要求，但触及同一批文件，主动补跑）：

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx --test tests/agents-space.test.ts tests/subagent-dispatches.test.ts tests/cockpit-team-expand.test.ts tests/agent-role-toggle.test.ts
```
→ 4/4 通过。

类型检查：

```
npx tsc -p tsconfig.typecheck.json
```
→ 无错误。

## 开放风险

- `hasReviewPending` 查询与 `blockedRow` 查询各自单独发一次 SQL（每角色 3 次小查询：running/blocked/reviewPending）。数据量级下（角色数 ≤ 双位数）性能影响可忽略；若未来角色数大增，可考虑合并查询，但当前范围未要求此优化，未做。
- `graphify update .` 在本仓库根目录与 worktree 目录各跑一次（worktree 有独立的 `graphify-out`），两处均已更新；未改动 graphify-out 之外的大文件。
