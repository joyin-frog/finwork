# Plan 053: 侧栏会话操作（置顶/重命名/删除/列表加载）失败可见、可回滚、可重试

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/shared/nav-state.tsx app/shared/app-nav.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug（UX 失败态）
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

侧栏所有会话操作都是「乐观更新 + 裸 fetch」：置顶失败无任何处理；重命名的 fetch 是丢在 `setConversations` 更新器**内部**的浮动 Promise（副作用进更新器，StrictMode 下还会双发）；删除先删本地再发请求、失败不回滚不提示；列表加载失败只 `setLoaded(true)`，界面显示与新用户完全相同的「暂无对话」且没有重试入口。任何一次瞬时 5xx/离线都会让侧栏与 DB 静默脱节，用户以为删了/改了名，下次启动全部弹回。

## Current state

- `app/shared/nav-state.tsx` —— 侧栏状态 context。四个问题点（原样摘录关键行）：

```ts
// 99-115 行 fetchConversations：catch 只 setLoaded(true)，无错误态
    } catch {
      setLoaded(true);
    } finally { ... }

// 129-142 行 doPin：乐观更新后 await fetch(...) 无 try/catch
    await fetch("/api/chat/recent", { method: "PATCH", ... });

// 155-168 行 commitRename：fetch 发在 setConversations 更新器内部（浮动 Promise）
    setConversations((prev) => {
      const latest = renameDraft.trim();
      if (!latest || latest === c.title) return prev;
      fetch("/api/chat/recent", { method: "PATCH", ... body: JSON.stringify({ id: c.id, action: "rename", title: latest }) });
      return prev.map((item) => (item.id === c.id ? { ...item, title: latest } : item));
    });

// 177-183 行 confirmDelete：先删本地态再 DELETE，失败无回滚
    setConversations((prev) => prev.filter((c) => c.id !== id));
    await fetch(`/api/chat/recent?id=${id}`, { method: "DELETE" });
```

- `app/shared/nav-state.tsx:1-3`：目前**未 import** `toast`（需从 `sonner` 引入，仓库统一用 `import { toast } from "sonner"`——`grep -rn 'from "sonner"' app/ | head -1` 核对写法）。
- 空态展示：`app/shared/app-nav.tsx:357-358` `loaded && recentConversations.length === 0` → 「暂无对话」。
- 文案约定（docs/ui-conventions.md）：错误=发生了什么+下一步；toast 点名对象；按钮=动词+宾语。
- NavState context 的 value 在 `nav-state.tsx:185` 起的 `useMemo` 里组装——新增字段要加进去并同步 type 定义（16 行起的 `type NavState`）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |
| e2e（可选）| `npm run test:e2e`      | 侧栏相关 journeys pass |

## Scope

**In scope**:
- `app/shared/nav-state.tsx`
- `app/shared/app-nav.tsx`（仅：列表加载失败的重试行）

**Out of scope**:
- `/api/chat/recent` 服务端。
- 「暂无对话」空态文案升级（归 plan 058）。
- 侧栏其余交互（resize、折叠、菜单）。

## Git workflow

- Branch: `advisor/053-nav-mutation-feedback`
- Commit：`fix(nav): 侧栏会话操作失败可见可回滚，列表加载失败可重试`
- 不 push、不开 PR。

## Steps

### Step 1: doPin 失败回滚 + toast

```ts
  const doPin = useCallback(async (c: ConversationSummary) => {
    const pinned = !c.pinned;
    setConversations((prev) => prev.map((item) => (item.id === c.id ? { ...item, pinned } : item)).sort(...));  // 现状不变
    setMenuId(null);
    try {
      const res = await fetch("/api/chat/recent", { ...现状... });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setConversations((prev) => prev.map((item) => (item.id === c.id ? { ...item, pinned: !pinned } : item)).sort(...));  // 回滚
      toast.error(pinned ? "置顶失败，已还原。检查网络后重试" : "取消置顶失败，已还原。检查网络后重试");
    }
  }, []);
```

（sort 逻辑照抄现状那行。）

**Verify**: `npm run typecheck` → exit 0

### Step 2: commitRename 把 fetch 移出更新器 + 失败回滚

重写为：先算 `latest`，不合法直接清理 rename 态返回；合法则记 `prevTitle = c.title`，乐观 `setConversations` 改标题（更新器内**只**做纯映射），然后 `await fetch`，`!res.ok`/异常时回滚标题 + `toast.error("重命名失败，已还原为「" + prevTitle + "」")`。函数改 async；依赖数组保持 `[renameDraft]`。

**Verify**: `npm run lint` → 0 error（更新器内无副作用后，如原先有相关 lint 抑制注释一并删除）

### Step 3: confirmDelete 失败恢复

保留「先删本地」的乐观模式，但 `await fetch` 包 try/catch + `!res.ok` 检查；失败时调用 `fetchConversations(0)` 重拉列表（比在内存里按原位置插回简单可靠）并 `toast.error("删除失败：对话已还原。检查网络后重试")`。

**Verify**: `npm run typecheck` → exit 0

### Step 4: 列表加载错误态 + 重试

- `nav-state.tsx`：加 `const [loadError, setLoadError] = useState(false);`；`fetchConversations` 成功清 false，catch 置 true；把 `loadError` 加进 NavState type、context value 的 useMemo。
- `app-nav.tsx`：在 `loaded && recentConversations.length === 0` 的「暂无对话」分支前，先判 `loadError` 渲染：`<button ... onClick={() => void fetchConversations(0)}>加载失败，点此重试</button>`（样式与「暂无对话」行一致：`px-3 py-2 text-meta text-muted-foreground`，加 `hover:bg-muted rounded` 交互态）。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 5: 全量回归

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`；环境可跑时 `npm run test:e2e` 侧栏场景 pass

## Test plan

nav-state 无既有单测；行为验证靠 e2e journeys 回归（重命名/删除路径已有覆盖则必须 pass）。新增单测不强求；若 e2e 环境不可用，在 audit 中记录人工验证步骤（dev server 断网模拟一次 pin 失败）。

## Done criteria

- [ ] `nav-state.tsx` 内不存在无错误处理的 `fetch(`（四处全覆盖：`grep -n "fetch(" app/shared/nav-state.tsx` 逐处确认在 try/catch 或 .catch 内且检查 res.ok）
- [ ] `setConversations` 的更新器内无 fetch 副作用
- [ ] 加载失败时侧栏出现重试按钮而非「暂无对话」
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 摘录与现状不符（漂移）。
- e2e 侧栏用例因回滚逻辑变化失败两次以上——报告而非硬改测试。
- 发现 `/api/chat/recent` PATCH/DELETE 返回结构没有可判成败的信号（非 2xx 之外还有 `{ok:false}` 形状）——按实际响应形状调整判定，写进 audit。

## Maintenance notes

- 已知 backlog：sidebar resize 逻辑 chat↔knowledge 重复——与本计划无关，别顺手抽 hook。
- Reviewer 看点：回滚路径的 sort 与乐观路径一致；StrictMode 下 rename 不再双发 PATCH。
