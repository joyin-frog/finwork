# Plan 050: fetchConversationFiles 加陈旧响应守卫，快速切换会话不再串台文件面板

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/chat/hooks/use-attachments.ts app/chat/chat-page.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

会话正文加载已有取消守卫（plans/011 已修），但文件面板的 `fetchConversationFiles` 没有：它有两个触发点（`loadConversation` 内与 conversationId effect），无取消令牌，`setConversationFiles` 无条件写入。A→B 快速切换时 A 的响应可能后到，覆盖 B 的文件列表；同时 `setConversationFilesLoaded(true)` 会用错误的文件计数触发文件面板的「默认展开」判定。用户看到的是别的会话的文件。

## Current state

- `app/chat/hooks/use-attachments.ts:28-38`（原样摘录）：

```ts
  async function fetchConversationFiles(id: number) {
    try {
      const res = await fetch(`/api/chat/attachments?conversationId=${id}`);
      const payload = (await res.json()) as { ok: boolean; data: { attachments: StoredChatAttachment[] } };
      if (payload.ok) setConversationFiles(payload.data.attachments);
    } catch {
      // File panel is helpful, not critical for chatting.
    } finally {
      setConversationFilesLoaded(true);
    }
  }
```

- 同文件 53–55 行的 effect：`if (conversationId) void fetchConversationFiles(conversationId);`，hook 参数里有 `conversationId: number | null`（20 行）。
- 第二触发点：`app/chat/chat-page.tsx:456-459` `loadConversation` 末尾 `await Promise.all([fetchConversationFiles(conversation.id), fetchFeedback(conversation.id)])`；另有回合完成后的刷新 `chat-page.tsx:363` `if (turn.conversationId) void fetchConversationFiles(turn.conversationId);`。
- 仓库同类先例：`app/agents/page.tsx:117-130` 用自增 `reqRef` 丢弃被抢占的旧响应——本计划采用**按 id 比对**的更简单变体。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| e2e（可选）| `npm run test:e2e`      | chat 相关 spec pass |

## Scope

**In scope**:
- `app/chat/hooks/use-attachments.ts`

**Out of scope**:
- `chat-page.tsx` 的调用点（守卫收在 hook 内，调用方零改动）。
- `fetchFeedback` / `loadConversation` 既有守卫。
- 已知 backlog 项 `getMessageFiles O(消息×文件)`——别顺手优化。

## Git workflow

- Branch: `advisor/050-conversation-files-race`
- Commit：`fix(chat): 会话文件列表丢弃陈旧响应（快速切换不串台）`
- 不 push、不开 PR。

## Steps

### Step 1: hook 内记录当前会话 id，写状态前比对

在 hook 顶部加 `const currentIdRef = useRef<number | null>(conversationId);`，并在 53–55 行的 effect 里先行 `currentIdRef.current = conversationId;`。`fetchConversationFiles` 改为：

```ts
  async function fetchConversationFiles(id: number) {
    try {
      const res = await fetch(`/api/chat/attachments?conversationId=${id}`);
      const payload = (await res.json()) as { ok: boolean; data: { attachments: StoredChatAttachment[] } };
      if (currentIdRef.current !== null && currentIdRef.current !== id) return; // 陈旧响应：会话已切走
      if (payload.ok) setConversationFiles(payload.data.attachments);
    } catch {
      // File panel is helpful, not critical for chatting.
    } finally {
      if (currentIdRef.current === null || currentIdRef.current === id) {
        setConversationFilesLoaded(true);
      }
    }
  }
```

注意保留 `currentIdRef.current === null` 放行：新会话页（conversationId 尚为 null）首个回合结束后 `turn.conversationId` 刷新时 id 还没进 props，此时不能丢弃。`useRef` 从 react import 处追加。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 2: 回归自查

`grep -n "currentIdRef" app/chat/hooks/use-attachments.ts` → 4 处命中（声明、effect 赋值、比对 ×2）。手动过一遍新会话流程逻辑：conversationId 为 null → ref 为 null → 刷新放行 ✓。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`

## Test plan

hook 无既有单测基建；靠 typecheck + 全量 e2e（`npm run test:e2e` 环境可跑时，chat journeys 必须 pass）。不新增测试文件。

## Done criteria

- [ ] `setConversationFiles` 前有 id 比对守卫
- [ ] 新会话（null id）场景不被误伤（代码走查 + e2e chat 场景 pass）
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 摘录与现状不符（漂移）。
- 发现 `conversationId` 在 URL 切换时不经该 hook 的 props 更新（守卫拿不到新 id）——报告。

## Maintenance notes

- 若将来文件面板改为 SSE 推送，此守卫可整体移除。
- Reviewer 看点：null 会话放行分支；`finally` 里 loaded 标记不被陈旧响应置位。
