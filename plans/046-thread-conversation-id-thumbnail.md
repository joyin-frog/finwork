# Plan 046: 把 conversationId 穿透到 ExpandedDetail，让工具步骤图片缩略图真正渲染

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/components/tool-call-step.tsx app/chat/components/assistant-turn.tsx`
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

`ExpandedDetail`（工具步骤展开详情）实现了「Read/read_document 读图片时顶部内联缩略图」功能（代码注释标 spec 12），但唯一调用点从不传 `conversationId`，导致 `imgSrc` 恒为 `null`，缩略图分支是永久死代码——用户展开一个读 PNG 的步骤永远只看到路径 chip。这是一个已实现却从未生效的功能，修复只是把 prop 穿透三层。

## Current state

- `app/components/tool-call-step.tsx` — 工具步骤渲染。
  - `ExpandedDetail`（176 行起）已声明 `conversationId?: string`，并在 191 行用它拼 `/api/files/${conversationId}/...` 缩略图 URL；无值时降级路径 chip（这是注释写明的既定降级）。
  - 唯一调用点（350 行）：`<ExpandedDetail pair={pair} />` —— 没传。
  - `ToolCallStep`（279 行）：`function ToolCallStep({ pair, degraded = false, threaded = false }: { pair: ToolPair; degraded?: boolean; threaded?: boolean })` —— 没有 conversationId prop。
  - `ToolStepList`（512 行）：props 为 `{ timeline, isActive, laterTimeline }` —— 也没有。`ToolStepList` 内部经 `rows` 渲染 `ToolCallStep` 与 `RetryGroupRow`（RetryGroupRow 内部也渲染 ToolCallStep，需一并穿透）。
- `app/chat/components/assistant-turn.tsx` — 调用方。131 行组件已接收 `conversationId`（类型 `number | null`，145 行），并已传给 `MarkdownMessage`（347/428 行），但 374 行 `<ToolStepList timeline={...} isActive={...} laterTimeline={...} />` 没传。
- 图片路由已存在：`app/api/files/[conversationId]/[...filename]/route.ts`（GET 返回文件流）。
- 仓库约定：surgical diff，只穿 prop，不重构。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0`（python 依赖缺失导致的用例失败与本计划无关） |

## Scope

**In scope**:
- `app/components/tool-call-step.tsx`
- `app/chat/components/assistant-turn.tsx`
- 若 grep 发现 `ToolStepList` 还有其他调用点（先跑 `grep -rn "ToolStepList" app/`），那些调用点允许传 prop（可选 prop，缺省不传保持降级行为）。

**Out of scope**:
- `/api/files` 路由；`isImagePath` 判定；缩略图样式。
- `MarkdownMessage` 及其 conversationId 用法。

## Git workflow

- Branch: `advisor/046-thumbnail-conversation-id`
- Commit：`fix(chat): 工具步骤缩略图接通 conversationId（spec 12 死代码激活）`
- 不 push、不开 PR。

## Steps

### Step 1: ToolStepList / ToolCallStep / RetryGroupRow 增加可选 prop

三处签名各加 `conversationId?: number | null`，一路向下透传；`ToolCallStep` 350 行改为 `<ExpandedDetail pair={pair} conversationId={conversationId ?? undefined ? String(conversationId) : undefined} />`——注意 `ExpandedDetail` 要的是 `string | undefined`，用 `conversationId != null ? String(conversationId) : undefined`。

**Verify**: `npm run typecheck` → exit 0

### Step 2: assistant-turn 传入

374 行 `<ToolStepList ... conversationId={conversationId} />`。同文件若还有其他 `<ToolStepList` 出现（先 grep），一并传。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 3: 手工验证（可行时）

若环境能跑 `npm run test:e2e:serve` + 浏览器：造一个含 Read 图片步骤的会话不现实（mock agent 固定脚本），故降级为静态验证：`grep -n "ExpandedDetail pair={pair}" app/components/tool-call-step.tsx` 确认已带 conversationId。

**Verify**: `grep -c "conversationId" app/components/tool-call-step.tsx` → 计数比改前增加（≥5）

## Test plan

本仓库对纯渲染穿 prop 无组件级单测惯例；回归靠 typecheck + 现有 e2e 全量（`npm run test:e2e` 若环境可跑）。不新增测试文件。

## Done criteria

- [ ] `npm run typecheck` exit 0；`npm run lint` 0 error
- [ ] `tool-call-step.tsx:350` 一带的 `ExpandedDetail` 调用含 `conversationId`
- [ ] `assistant-turn.tsx` 的 `ToolStepList` 调用含 `conversationId={conversationId}`
- [ ] `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` `# fail 0`
- [ ] `git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- `ExpandedDetail` 的 `conversationId` 类型不再是 `string`（说明有人动过，先核对再报告）。
- `ToolStepList` 的调用点超过 3 处或存在于 scope 外目录——报告后再定。
- typecheck 因 `ToolPair`/timeline 类型联动报错且一次修复不掉。

## Maintenance notes

- 若将来 `/api/files` 路由鉴权或路径规则变化，`imgSrc` 拼接要同步。
- Reviewer 看点：prop 全程可选、缺省行为（降级 chip）不变；没有顺手改动缩略图样式。
