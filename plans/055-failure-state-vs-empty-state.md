# Plan 055: 失败态 ≠ 空态——知识库/总览/派发记录/全局搜索的加载失败可见可重试

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/knowledge/page.tsx app/cockpit/page.tsx app/agents/page.tsx app/agents/agent-detail-drawer.tsx app/shared/global-search-dialog.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug（UX 失败态模式）
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

同一个反模式出现在四个面上：**请求失败呈现为空数据**。知识库加载失败显示空文档库；总览页 loading 期间渲染 `summary=null` 的卡片网格，所有卡显示「暂无经营数据」（加载态与空态不可区分，唯一线索是 header 里一个 16px 的旋转图标）；智能体派发记录失败显示「暂无派发记录」；全局搜索不看 HTTP 状态、5xx 静默展示旧结果。用户无法区分「没有数据」和「没拿到数据」，也没有重试入口。仓库里已有正确范例（agents 角色列表、cockpit 的 error 分支），本计划把四个漏网点对齐到该范例。

## Current state

1. **知识库** `app/knowledge/page.tsx:259-264`（原样摘录）：

```ts
  const fetchDocs = useCallback(async () => {
    const res = await fetch("/api/knowledge/documents"); const json = await res.json();
    if (json.ok) setDocs(json.data.documents);
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);
```

无 try/catch、`json.ok === false` 静默；`confirmDelete`（281-287 行）删除后 `fetchDocs()` 同样裸调。

2. **总览** `app/cockpit/page.tsx`：fetch（40-51 行）有 error state ✓，但 74 行渲染只分 `error ? ... : <内容>` 两支——`loading && !error` 时进内容支，`summary=null` 传给各卡 → 卡片自身的空态文案（如 `business-metrics-card.tsx` 的「暂无经营数据」）被当成加载态展示。

3. **派发记录** `app/agents/page.tsx:125-127`：`catch { ...; setDispatches([]); }` → 抽屉显示「暂无派发记录」，无错误态、无重试。（该函数 117-130 行已有 `dispatchReqRef` 抢占守卫——保留。）

4. **全局搜索** `app/shared/global-search-dialog.tsx:33-38`（原样摘录）：

```ts
    fetch("/api/search?q=" + encodeURIComponent(query))
      .then((r) => r.json())
      .then((json: { ok: boolean; data?: SearchData }) => {
        if (json.ok && json.data) setData(json.data);
      })
      .catch(() => {});
```

- **对齐范例**（勿改，抄它）：`app/cockpit/page.tsx:74-78` 的错误分支——居中 `text-body text-muted-foreground` 错误文案 + `<Button variant="outline" size="sm" onClick={fetchSummary}>重试</Button>`；以及 `app/agents/page.tsx` 角色列表的错误+重试（约 222-228 行，现场核对）。
- 文案约定（docs/ui-conventions.md）：错误=发生了什么+下一步；空状态指向第一个动作；进行中用「…中」。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |
| e2e（可选）| `npm run test:e2e`      | knowledge/cockpit/agents journeys pass |

## Scope

**In scope**:
- `app/knowledge/page.tsx`（fetchDocs 错误态 + 重试行）
- `app/cockpit/page.tsx`（loading 分支）
- `app/agents/page.tsx` + `app/agents/agent-detail-drawer.tsx`（dispatchError 传递与展示）
- `app/shared/global-search-dialog.tsx`（r.ok 检查 + 轻量失败提示）

**Out of scope**:
- 各卡片组件的空态文案本身（`business-metrics-card.tsx` 等——空态语义正确，问题在页面层）。
- 侧栏对话列表（plan 053 处理）。
- 骨架屏组件体系（不新建 Skeleton 组件，用简单 spinner/文案，见 Step 2）。

## Git workflow

- Branch: `advisor/055-failure-vs-empty`
- Commit：`fix(ux): 加载失败态与空态分离（知识库/总览/派发/搜索）`
- 不 push、不开 PR。

## Steps

### Step 1: 知识库 fetchDocs

`const [docsError, setDocsError] = useState(false);`；fetchDocs 包 try/catch：成功清 false；`!res.ok || !json.ok` 或异常置 true。渲染：文档网格区域当 `docsError && docs.length === 0` 时显示「文档加载失败。」+「重试」按钮（抄 cockpit 74-78 行的结构与类名）。`confirmDelete` 里的 `fetchDocs()` 改 `void fetchDocs()`（错误已在函数内消化）。

**Verify**: `npm run typecheck` → exit 0

### Step 2: 总览 loading 分支

74 行渲染改为三支：`error ? <现有错误支> : loading && !summary ? <加载支> : <现有内容支>`。加载支：`<div className="flex items-center justify-center py-16 text-body text-muted-foreground">加载中…</div>`（省略号用 `…` 字符）。仅首次加载生效（`summary` 已有值时刷新按现状走 header 转圈，不闪整页）。

**Verify**: `npm run lint` → 0 error

### Step 3: 派发记录错误态

`app/agents/page.tsx`：加 `const [dispatchError, setDispatchError] = useState(false);`；`handleSelectRole` 里发请求前清 false，catch 与 `json.ok === false` 分支置 true（保持 `dispatchReqRef` 抢占判定：只有 `reqId === dispatchReqRef.current` 时才写）。把 `dispatchError` 作为 prop 传入 `AgentDetailDrawer`；抽屉里派发记录区域当 `dispatchError` 时渲染「派发记录加载失败。」+「重试」（onClick 重新调用 `handleSelectRole` 需要 roleId——把重试回调 `onRetryDispatches?: () => void` 作为 prop 由 page 传入，绑定当前 selectedRoleId）。

**Verify**: `npm run typecheck` → exit 0

### Step 4: 全局搜索 HTTP 层检查

fetch 链首段改 `.then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })`；`.catch` 里置 `const [failed, setFailed] = useState(false)`，成功路径清 false；对话框结果区当 `failed` 时显示一行 `text-meta text-muted-foreground`「搜索暂时不可用，稍后重试」（不清空已有 data，轻提示即可）。

**Verify**: `npm run lint` → 0 error

### Step 5: 全量回归

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`；环境可跑时 `npm run test:e2e` 相关 journeys pass

## Test plan

页面级失败态无单测基建；e2e 既有 journeys 必须回归通过。audit 中记录每个面的人工验证方式（dev 下临时把 fetch URL 改错一位看错误态——验证完还原）。

## Done criteria

- [ ] 四个面上「请求失败」与「数据为空」渲染可区分，前三者有重试入口
- [ ] cockpit 首次加载不再展示各卡空态文案
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 任一摘录与现状不符（漂移）。
- `AgentDetailDrawer` props 结构与预期差异大（如已迁移状态管理）——报告。
- e2e 因 loading 分支时序失败两次以上——报告而非加 sleep。

## Maintenance notes

- 这个「失败≠空」模式今后每个新列表页都要带上；正例已有三处（cockpit error 支、agents 角色列表、本计划新增）可抄。
- Reviewer 看点：派发抢占守卫（reqRef）没有被错误态逻辑破坏；搜索失败不闪掉已展示结果。
