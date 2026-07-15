# Plan 052: run_python 会话级信任可撤销（revoke API + 对话内可见入口）

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- lib/agent/hooks/session-trust.ts lib/agent/hooks/chain.ts lib/agent/hooks/built-in.ts app/components/ask-user-panel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug（防护收敛缺口）
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

用户在 run_python 确认卡勾选「本次对话不再询问」后，该会话内的代码执行永久免确认（进程不重启就一直有效），而当前**不存在任何撤销通道**——没有 revoke 函数、没有 UI 入口。确认卡明示该工具能「读取、修改本机文件并执行代码」，信任一旦给出就收不回，是防护收敛（damage containment）缺口：会话后续若被文档内容注入，用户无法把闸门关回去。

## Current state

- `lib/agent/hooks/session-trust.ts`（全文 39 行）——进程内 `Set<string>`，key 为 `${conversationId}:${toolName}`；只有 `trustToolForConversation`（add）与 `isToolTrustedForConversation`（has），无 delete。文件头注释声明：**严禁 node: 前缀导入**（该文件被客户端组件 import sentinel 常量），保持这一约束。
- 写入点：`lib/agent/hooks/chain.ts:39-41` —— 用户提交 `SESSION_TRUST_CONFIRM_ANSWER` 时调用 `trustToolForConversation(ctx.conversationId, ctx.toolName)`。
- 消费点：`lib/agent/hooks/built-in.ts:185-189` —— `isPython && ctx.resolveUserQuestion && isToolTrustedForConversation(...)` 直接 allow。
- 前端勾选处：`app/components/ask-user-panel.tsx:196` —— `submit(trustSession ? SESSION_TRUST_CONFIRM_ANSWER : "确认")`。
- 中间件：`middleware.ts` 对 `/api/*` 全部做 `isTrustedLocalRequest` 校验（新路由自动被覆盖，无需额外鉴权代码）。
- API 路由约定：参照 `app/api/agent/answer/route.ts`（POST + JSON body + `{ ok: true }` 响应形状）。
- UI 文案约定（docs/ui-conventions.md）：按钮=动词+宾语；toast 点名对象不说「成功」。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |

## Scope

**In scope**:
- `lib/agent/hooks/session-trust.ts`（加 revoke + 查询）
- `app/api/agent/trust/route.ts`（新建：GET 查询 + DELETE 撤销）
- `app/chat/chat-page.tsx`（信任状态 chip/入口；若 header 区域另有组件文件，允许触碰该 header 组件）
- 相关测试（`tests/` 内既有 session-trust / agent-confirm-flow 用例处追加；先 `grep -rn "session-trust\|trustToolForConversation" tests/`）

**Out of scope**:
- 信任的授予流程（chain.ts / ask-user-panel 勾选逻辑不动）。
- built-in.ts 的放行判定（revoke 后 Set 里没 key，判定自然回到确认路径，无需改）。
- 信任持久化到 DB（进程内即失效是既定设计，见 session-trust.ts 头注释）。

## Git workflow

- Branch: `advisor/052-run-python-trust-revoke`
- Commit：`feat(agent): run_python 会话信任可撤销`
- 不 push、不开 PR。

## Steps

### Step 1: session-trust.ts 加两个函数

```ts
/** 撤销 (conversationId, toolName) 的信任。不存在时无操作。 */
export function revokeToolTrust(conversationId: number | undefined, toolName: string): void {
  if (conversationId == null) return;
  getTrustStore().delete(trustKey(conversationId, toolName));
}

/** 列出某会话当前被信任的工具名（供 UI 展示）。 */
export function listTrustedTools(conversationId: number | undefined): string[] {
  if (conversationId == null) return [];
  const prefix = `${conversationId}:`;
  return [...getTrustStore()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}
```

不引入任何 node: 依赖。

**Verify**: `npm run typecheck` → exit 0

### Step 2: 新建 `/api/agent/trust` 路由

`app/api/agent/trust/route.ts`：
- `GET ?conversationId=N` → `{ ok: true, data: { tools: listTrustedTools(N) } }`；conversationId 非正整数 → 400。
- `DELETE` body `{ conversationId, toolName }` → `revokeToolTrust(...)`，返回 `{ ok: true }`；参数校验同上。
响应/校验风格仿 `app/api/agent/answer/route.ts`。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 3: 对话页信任入口

`chat-page.tsx`：会话加载后（`loadConversation` 成功处）与 ask-user 面板 resolve 后各触发一次 `GET /api/agent/trust?conversationId=...`，存 `trustedTools: string[]` state。当列表含 run_python 类工具时，在对话 header 区域渲染一个小 chip：文案「已信任代码执行 · 撤销」，点击「撤销」调 DELETE 后刷新状态并 `toast("已恢复每次确认")`（对象点名，无「成功」字样）。样式走语义 token（`text-meta text-muted-foreground`、hover `hover:bg-muted`），间距按组内 `gap-2`。若 header 已拥挤，放到会话标题右侧下拉/工具区——跟随现场结构，最小侵入。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 4: 测试

- 单测（在既有 session-trust 或 confirm-flow 测试处追加）：trust → `isToolTrustedForConversation` true → `revokeToolTrust` → false；`listTrustedTools` 只回本会话条目。
- 若 tests/ 有 API route 直测惯例则给 trust 路由补 400/ok 两例；无惯例则跳过（说明写进 audit）。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`，新用例 pass

## Test plan

见 Step 4。模式仿 `tests/` 中现有 agent-confirm-flow / session-trust 用例。

## Done criteria

- [ ] revoke 后同会话下一次 run_python 重新弹确认（单测经 Set 状态断言）
- [ ] GET/DELETE 路由存在且参数校验齐全
- [ ] 对话页在已信任时可见撤销入口，点击后 chip 消失
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- session-trust.ts 结构与摘录不符（漂移）。
- chat-page header 结构变化大、chip 无处安放且需要重排 header——停下报告（UI 位置是产品决策）。
- 发现信任 key 的 toolName 带 mcp 前缀不一致（写入用 `ctx.toolName` 原样）——先打印实际 key 核对，别猜。

## Maintenance notes

- 信任存储是进程内的：桌面版重启失效——UI 文案不要暗示持久。
- 后续若把信任升级为持久化/带 TTL，GET/DELETE 契约可保持不变。
- Reviewer 看点：客户端组件没有间接 import 出 node: 依赖（session-trust.ts 头注释的约束）。
