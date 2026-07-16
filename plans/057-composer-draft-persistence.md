# Plan 057: composer 草稿按会话持久化到 sessionStorage，切页不再丢

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/chat/chat-page.tsx app/chat/hooks/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug（UX 数据丢失）
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

输入框草稿是纯组件 state。用户写了几段复杂财务 prompt，误点侧栏「总览」再回来——草稿没了，零提示。桌面工作台场景长草稿常见，丢一次足够伤信任。修法取最简：草稿随键入防抖写 `sessionStorage`（按会话 key），回到页面时恢复；不做导航拦截对话框（App Router 拦导航支持有限，且恢复式比拦截式体验更好）。sessionStorage 生命周期=应用会话，重启即清，不会积累陈旧草稿。

## Current state

- `app/chat/chat-page.tsx:118`：`const [draft, setDraft] = useState(initialDraft ?? "");`
- 键入入口 `chat-page.tsx:620-628`：`handleDraftChange` 内 `setDraft(value)`（随后是 @mention / slash 检测逻辑，勿动）。
- 其他 `setDraft` 调用点（发送后清空、错误恢复、撤回等）：`grep -n "setDraft" app/chat/chat-page.tsx` 全部列出后逐一确认——**发送成功清空草稿时必须同时清 storage**，否则重启前误恢复已发送内容。
- 会话标识：`conversationId: number | null`（新会话为 null，用 key `"new"`）。页面有 `mode`（"new" / "recent"）——现场确认变量名。
- 既有 sessionStorage 用法范例：`app/chat/hooks/use-attachments.ts:41-51`（`pendingChatAttachments` 读后即删、try/catch 包裹）——匹配其防御风格。
- `initialDraft` 语义：来自跨页跳转（快捷 prompt 等）——**优先级高于恢复的草稿**（用户显式带入的内容不能被旧草稿覆盖）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |
| e2e（可选）| `npm run test:e2e`      | chat journeys pass |

## Scope

**In scope**:
- `app/chat/chat-page.tsx`
- （可选）新 hook 文件 `app/chat/hooks/use-draft-persistence.ts`——若 chat-page 内联超过 ~25 行则抽 hook，跟随 hooks/ 目录现有风格

**Out of scope**:
- 附件/技能引用的持久化（dataUrl 太大，sessionStorage 5MB 限额，显式不做——只存文本）。
- beforeunload / 导航拦截对话框。
- localStorage（跨重启恢复显式不做，避免陈旧草稿）。

## Git workflow

- Branch: `advisor/057-draft-persistence`
- Commit：`feat(chat): composer 草稿按会话持久化（sessionStorage）`
- 不 push、不开 PR。

## Steps

### Step 1: 存

key 规则：`chat-draft:${conversationId ?? "new"}`。在 `handleDraftChange` 的 `setDraft(value)` 后加防抖写（300ms，`useRef<ReturnType<typeof setTimeout>>` 实现，组件卸载时 flush 最后一笔——卸载 effect cleanup 里同步写一次当前值）。空串直接 `sessionStorage.removeItem(key)`。全部 try/catch 包裹（匹配 use-attachments 风格）。

**Verify**: `npm run typecheck` → exit 0

### Step 2: 取

初始 state 改为惰性初始化：

```ts
const [draft, setDraft] = useState(() => {
  if (initialDraft) return initialDraft;            // 显式带入优先
  try { return sessionStorage.getItem(`chat-draft:${conversationId ?? "new"}`) ?? ""; }
  catch { return ""; }
});
```

注意 SSR：chat-page 是 "use client" 但首渲染可能在无 sessionStorage 环境（Next 预渲染）——`typeof window === "undefined"` 时返回 `""`，或确认该组件动态挂载不 SSR（现场看 page.tsx 是否 `dynamic`/客户端边界；不确定就加 window 判定，无害）。会话切换（conversationId 变）时若 draft 为空也尝试恢复对应 key（在现有 loadConversation 流程或 conversationId effect 里补一次读取，非空 draft 不覆盖）。

**Verify**: `npm run lint` → 0 error

### Step 3: 清

`grep -n "setDraft" app/chat/chat-page.tsx` 找到「发送成功清空」的调用点（submit 流程里 `setDraft("")` 处），同步 `sessionStorage.removeItem(key)`。错误恢复分支的 `setDraft(out.text)`（371-378 行）不需要额外处理——防抖写会随 state 变化自然跟上？**不会**（那是直接 setState 不经 handleDraftChange）——所以把「写 storage」抽成一个小函数 `persistDraft(value)`，在 submit 清空处和错误恢复处都显式调用，键入防抖也走它。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`

### Step 4: e2e 快验（环境可跑时）

`npm run test:e2e:serve` 起 mock 服务，手动/脚本验证：输入文字 → 点「总览」→ 回对话页 → 文字还在；发送成功 → 离开再回 → 输入框为空。

**Verify**: 两条流转符合预期

## Test plan

若 e2e journeys 结构便于插入（`e2e/journeys.spec.ts` 已覆盖 chat 流程），加一小段「切页回来草稿保留」断言；不便则在 audit 记录 Step 4 手测结果。单测层不测（纯浏览器 storage 行为）。

## Done criteria

- [ ] 切页往返草稿保留；发送成功后 storage 已清；`initialDraft` 优先于恢复值
- [ ] 新会话（null id）与既有会话互不串 key
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- `chat-page.tsx` 的 draft 管理已迁移（漂移）。
- 发现 draft 状态同时被 composer 之外的组件消费且恢复逻辑引起回环——报告。
- e2e 出现 hydration 报错（SSR 读 storage）——按 Step 2 的 window 判定修一次，仍报错则 STOP。

## Maintenance notes

- 附件持久化显式不做（体积）；若将来做，应存引用（storagePath）而非 dataUrl。
- Reviewer 看点：防抖计时器卸载清理；「撤回」（retractMessage 的 setDraft）也应走 persistDraft——执行时顺手确认，属同一函数改造范围。
