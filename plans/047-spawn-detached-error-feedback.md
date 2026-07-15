# Plan 047: spawnDetached 等到 spawn 事件再 resolve，「打开文件」失败不再静默成功

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- "app/api/files/[conversationId]/[...filename]/route.ts"`
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

「用系统应用打开文件 / 在文件管理器中显示」底层的 `spawnDetached` 在注册完 `error` 监听后**同步** `resolve()`。Node 的 `error` 事件是异步派发的，Promise 那时已 settle，`reject` 成为 no-op。于是可执行文件不存在、无权限等所有启动失败都吞掉，HTTP 层照样返回成功——用户点「打开」毫无反应也毫无提示。

## Current state

- `app/api/files/[conversationId]/[...filename]/route.ts` — 文件流路由 + 打开/定位文件的 POST 动作。96–103 行（原样摘录）：

```ts
function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}
```

- 调用方：`openWithSystemApp`（75–94 行，按平台拼 open/cmd/xdg-open/rundll32 命令）与 `revealInFileManager`（105–113 行）。再上层的 POST handler 会把这两个函数的结果转成 JSON 响应（找到该文件里 `openWithSystemApp(` 的调用处确认错误如何转响应——若当前根本没有 try/catch，把 handler 侧补上 `try { ... } catch { return NextResponse.json({ ok: false, error: "..." }, { status: 500 }) }` 形状，与同文件 GET 的错误响应风格一致）。
- Node 语义：`child.once("spawn", ...)` 在进程成功启动后触发；启动失败只触发 `error`。两者互斥，`detached` + `unref` 不影响这两个事件。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |

## Scope

**In scope**:
- `app/api/files/[conversationId]/[...filename]/route.ts`
- 前端错误提示（仅当 POST 调用方目前完全不处理失败响应时）：`app/chat/chat-file-browser.tsx` 等调用 `/api/files` POST 的位置——先 `grep -rn "打开方式\|openWith\|reveal" app/` 找到调用点；若它已对 `!res.ok`/`!json.ok` 弹 toast，则前端零改动。

**Out of scope**:
- `isAllowedAppPath` 等安全校验逻辑。
- GET 文件流分支。

## Git workflow

- Branch: `advisor/047-spawn-detached-feedback`
- Commit：`fix(files): 打开文件失败不再静默成功（spawn 确认后才 resolve）`
- 不 push、不开 PR。

## Steps

### Step 1: 修 spawnDetached

```ts
function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => { child.unref(); resolve(); });
    child.once("error", reject);
  });
}
```

**Verify**: `npm run typecheck` → exit 0

### Step 2: 确认 POST handler 把 rejection 转成用户可见错误

读该文件的 POST handler：若 `await openWithSystemApp(...)` 未包 try/catch，则补上，失败返回 `{ ok: false, error: "打开失败：未找到可用的应用。可换「在文件夹中显示」后手动打开。" }`（文案遵守 docs/ui-conventions.md：发生了什么 + 下一步）。若已有 try/catch 则只核对文案是否给出下一步，不达标就替换。

**Verify**: `npm run lint` → 0 error

### Step 3: 前端调用点核对

grep 找到调用该 POST 的前端代码；确认失败响应会 toast（若已有 toast.error 逻辑则不动）。若完全没有失败分支，补 `toast.error(json.error ?? "打开失败", ...)`。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`

## Test plan

- 若 `tests/` 已有针对该 route 的测试（`grep -rn "files/\[conversationId\]" tests/` 确认），仿其模式加一例：`spawnDetached("/nonexistent-binary-xyz", [])` 期望 reject。若该函数未导出且无既有 route 测试模式，则不强行加测（导出仅为测试会扩大 API 面），在 audit 说明中记录人工验证方式：mac 上 `curl -X POST` 一个 appPath 指向不存在路径的请求，期望 `ok:false`。

## Done criteria

- [ ] `spawnDetached` 内 `resolve` 只在 `spawn` 事件后调用（`grep -n 'once("spawn"' <route file>` 命中）
- [ ] POST 失败路径返回 `ok:false` + 带下一步的中文文案
- [ ] `npm run typecheck` / `npm run lint` / 单测全绿
- [ ] `git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- POST handler 结构与预期差异大（例如动作已迁去别的路由）——报告。
- 前端调用点超过 2 处且各自错误处理不一致——列出后停，由维护者定统一策略。

## Maintenance notes

- Windows 的 `cmd /c start` 即使目标应用打不开也可能 spawn 成功（start 本身成功）——本修复只保证「进程没起来」不再假成功，Windows 深层失败检测显式不做（收益低）。
- Reviewer 看点：`unref()` 移到 spawn 回调内不影响 detach 语义（spawn 后 unref 依然有效）。
