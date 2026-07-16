# Plan 051: 流式进行中禁用「撤回」，防止错误恢复覆盖撤回内容

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/chat/chat-page.tsx app/chat/components/user-bubble.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

「撤回」把某条历史 user 消息的文字+附件填回输入框（非破坏性，见 chat-page.tsx:802 注释）。但若当前正有回合在流式进行、随后回合报错，错误分支会无条件用 `lastOutgoingRef`（**最近发出的**那条消息）恢复输入框——把用户刚撤回的内容整个覆盖掉，撤回意图静默丢失。两个意图（错误恢复 / 撤回编辑）争同一个 composer，最小修复是流式期间不允许撤回。

## Current state

- 错误恢复分支 `app/chat/chat-page.tsx:370-379`（原样摘录，节选）：

```ts
    } else {
      // error / stopped:把已流式内容定格进本地消息,并把草稿文本+附件还回输入框便于一键重试
      setMessages(overlayMessages(turn));
      const out = lastOutgoingRef.current;
      if (out) {
        setAttachments(out.attachments);
        setReferencedAttachments(out.referencedAttachments);
        setReferencedSkills(out.referencedSkills);
        if (turn.status === "error" && out.text) setDraft(out.text);
      }
```

- 撤回实现 `app/chat/chat-page.tsx:806-816`：`retractMessage(message)` 直接 `setDraft`/`setReferencedAttachments`/`setAttachments([])`/`setReferencedSkills([])`，无 loading 守卫。
- 撤回按钮 `app/chat/components/user-bubble.tsx:111-120`：`{onRetract ? (<button ... onClick={onRetract}>` 无 `disabled`。
- chat-page 里流式进行中的判定：找到传给 UserBubble `onRetract` 的位置（`grep -n "onRetract" app/chat/chat-page.tsx`），以及页面的 loading/turn 状态变量（`turnKey` 非空即有活动回合；也可能已有 `loading` 派生值——先读现场确认用哪个）。
- 交互约定（docs/ui-conventions.md）：disabled 统一 `disabled:opacity-50 disabled:pointer-events-none`。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |

## Scope

**In scope**:
- `app/chat/chat-page.tsx`（retractMessage 守卫 + onRetract 传参处）
- `app/chat/components/user-bubble.tsx`（按钮 disabled 态）
- `tests/` 中若存在 suppress-lock / user-bubble 相关计数测试需要同步上限，允许最小调整（见 Maintenance notes）

**Out of scope**:
- 错误恢复分支本身（`setDraft(out.text)` 行为保持——它服务的「一键重试」是主路径）。
- 撤回的语义（不做「流式中撤回=排队生效」这类复杂化）。

## Git workflow

- Branch: `advisor/051-retract-stream-guard`
- Commit：`fix(chat): 流式进行中禁用撤回，防错误恢复覆盖`
- 不 push、不开 PR。

## Steps

### Step 1: retractMessage 顶部加守卫

`retractMessage` 开头：`if (turnKey) return;`（若现场已有更语义化的 loading 变量则用之；与 Step 2 的 disabled 条件保持同一来源）。

**Verify**: `npm run typecheck` → exit 0

### Step 2: 按钮呈现 disabled 态

`UserBubble` 增加可选 prop `retractDisabled?: boolean`；按钮加 `disabled={retractDisabled}`，className 追加 `disabled:opacity-50 disabled:pointer-events-none`（约定写法），`aria-label` 不变。chat-page 传 `retractDisabled={!!turnKey}`（与 Step 1 同源）。

**Verify**: `npm run lint` → 0 error

### Step 3: 全量回归

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`（若 suppress-lock 计数用例失败且失败原因是本改动增删了 `eslint-disable` 行，按该测试文件内注释调整上限并在提交说明标注；其他失败一律 STOP）

## Test plan

行为守卫在纯 UI 事件层，无既有组件测试基建；以 typecheck + lint + 全量单测回归 + e2e（环境可跑时）为准。不新增测试文件。

## Done criteria

- [ ] 流式进行中（turnKey 非空）`retractMessage` 直接 return，按钮呈 disabled
- [ ] 非流式期撤回行为与改前完全一致
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 摘录与现状不符（漂移）。
- 发现 onRetract 只在历史消息 hover 工具栏出现、且该工具栏在流式期本来就不渲染（即 bug 不可达）——验证后如属实，把本计划标 REJECTED 并写一行理由。

## Maintenance notes

- 仓库有「suppress-lock」测试锁 eslint-disable 总数（见 git log `2497e80`）；给 button 加 disabled 不应新增 disable 注释，若加了会触发计数。
- 后续若做「编辑重发」一体化功能，此守卫逻辑应并入其状态机。
