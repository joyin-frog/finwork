# Plan 056: 流式进行中关闭 Tauri 窗口先确认（防止长任务静默丢失）

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- src-tauri/src/lib.rs app/shared/chat-stream.tsx src-tauri/capabilities/ src-tauri/tauri.conf.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED（触碰关窗路径，弄错会留僵尸进程或关不掉窗）
- **Depends on**: none
- **Category**: bug（数据丢失防护）
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

桌面版在 `CloseRequested` 时无条件杀掉 Next.js 子进程。agent 长任务（多步工具链，动辄几分钟）进行中误点关闭 → 回合即刻中断，只有已持久化的片段幸存，无任何确认。目标：有活动流时关窗先弹应用内确认（「智能体正在执行任务。仍要退出？」），确认后才放行。

**实现策略（重要）**：不做 Rust↔JS IPC 状态同步（复杂且易错）。改用 Tauri 前端 API：**在渲染层监听窗口关闭请求并 preventDefault**，Rust 侧 kill 子进程的现有逻辑保持不变（它只在真正关闭时触发）。Tauri 2 的 `getCurrentWindow().onCloseRequested(handler)` 在 JS 侧即可 `event.preventDefault()`，这是官方支持的路径，改动全部落在前端 + capability 配置。

## Current state

- Rust 侧 `src-tauri/src/lib.rs:116-124`（原样摘录，**保持不动**）：

```rust
    .on_window_event(|window, event| {
      if matches!(event, WindowEvent::CloseRequested { .. }) {
        let state = window.app_handle().state::<ServerProcess>();
        let child = state.0.lock().expect("server process lock poisoned").take();
        if let Some(mut child) = child {
          let _ = child.kill();
        }
      }
    })
```

（注意：JS 侧 preventDefault 后 Rust 的这个 handler**不会**收到最终 close；Tauri 中 JS 的 onCloseRequested 先于默认行为。需实测验证 kill 逻辑仍在真正关闭时执行——见 Step 4 与 STOP。）

- 活动流注册表：`app/shared/chat-stream.tsx:170` 起 `ChatStreamProvider` 持有 `turns: Record<string, StreamTurn>` 与 `isFinished(status)`（166 行）。「有活动流」= 存在 `!isFinished(t.status)` 的 turn。
- Tauri 前端 API 已在用：`app/shared/window-controls.tsx:4` `import { getCurrentWindow } from "@tauri-apps/api/window"`；`isTauri` 判定见 `app/files/page.tsx:5`。
- 确认对话框範例：`app/shared/confirm-dialog.tsx`（ConfirmDialog props 见该文件 14-23 行）。
- capability 权限：`src-tauri/capabilities/`（onCloseRequested 需要 `core:window:allow-close` 等权限——现场查现有 capability JSON 里 window 相关授权，缺则补）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |
| 桌面实测  | `npm run tauri:dev`      | 见 Step 4（需本机 Rust 工具链；无则 BLOCKED） |

## Scope

**In scope**:
- `app/shared/chat-stream.tsx`（暴露 `hasActiveTurns` 派生值到 context）
- 新文件 `app/shared/close-guard.tsx`（挂在 layout 的客户端组件）
- `app/layout.tsx`（挂载 close-guard，一行）
- `src-tauri/capabilities/*.json`（仅当权限缺失）

**Out of scope**:
- `src-tauri/src/lib.rs`（Rust 零改动——若实测发现必须动，STOP 报告）。
- 浏览器版 `beforeunload`（桌面是主要形态；浏览器版留给 plan 057 的草稿防丢一并考虑）。
- 「关窗前自动停止回合并保存」之类的高级行为。

## Git workflow

- Branch: `advisor/056-close-guard`
- Commit：`feat(desktop): 流式进行中关窗先确认`
- 不 push、不开 PR。

## Steps

### Step 1: chat-stream 暴露 hasActiveTurns

`ChatStreamProvider` 里派生 `const hasActiveTurns = Object.values(turns).some((t) => !isFinished(t.status));` 加入 context value（type 同步）。

**Verify**: `npm run typecheck` → exit 0

### Step 2: close-guard 组件

`app/shared/close-guard.tsx`（"use client"）：
- `isTauri()` 为 false 时返回 null。
- effect 内 `const win = getCurrentWindow(); const unlisten = await win.onCloseRequested(async (event) => { if (hasActiveTurnsRef.current) { event.preventDefault(); setConfirmOpen(true); } });`，cleanup 调 unlisten。`hasActiveTurns` 经 ref 持最新值（监听器只注册一次）。
- `ConfirmDialog`：`title="智能体正在执行任务"` `description="现在退出会中断进行中的回合，已完成的部分会保留。"` `confirmLabel="仍要退出"` `destructive` `onConfirm={() => void getCurrentWindow().destroy()}`。（用 `destroy()` 跳过再次触发 onCloseRequested 的循环；若 destroy 不触发 Rust 的 CloseRequested 分支导致子进程残留，见 Step 4 实测与 STOP。备选：设 `bypassRef.current = true` 后调 `win.close()`，监听器里 bypass 时直接放行。**优先备选方案**，因为它保证 Rust kill 路径照常走：`onConfirm={() => { bypassRef.current = true; void getCurrentWindow().close(); }}`。）
- 组件在 `ChatStreamProvider` 内层使用 `useChatStream()` 读 hasActiveTurns。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 3: 挂载

`app/layout.tsx` 里（`ChatStreamProvider` 的内层——先看 provider 挂在哪个文件，可能在嵌套 providers 组件里）加 `<CloseGuard />`。

**Verify**: `npm run typecheck` → exit 0

### Step 4: 桌面实测（关键）

`npm run tauri:dev`：
1. 无活动流：点关闭 → 窗口正常关、`next-server` 子进程退出（`ps aux | grep next` 确认无残留）。
2. mock 流进行中（发一条消息立刻点关闭）→ 出现确认框；取消 → 窗口保留；确认 → 窗口关闭、子进程退出。

**Verify**: 上述两轮手测通过 + 无僵尸 node 进程

## Test plan

单测无法覆盖 Tauri 窗口事件；以 Step 4 桌面手测为验收，audit 里记录测试录像/步骤。`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 全量回归防误伤。

## Done criteria

- [ ] 无活动流关窗行为与改前一致（含子进程回收）
- [ ] 有活动流关窗出现应用内确认，双分支行为正确
- [ ] 浏览器版（非 Tauri）零行为变化
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 本机无 Rust 工具链跑不了 `tauri:dev` → 完成 Step 1-3 后标 **BLOCKED（需人工桌面验证）**，这是可接受的结束状态。
- `onCloseRequested` 需要的 capability 权限补了之后仍不生效（Tauri 版本/权限模型不符）→ 报告，不要转而改 Rust。
- 确认退出后子进程残留（bypass+close 路径没走到 Rust kill）→ 报告实测现象，不要自行改 lib.rs。

## Maintenance notes

- 将来若加「后台任务队列」（对话页外跑任务），hasActiveTurns 的口径要扩展。
- Reviewer 看点：监听器 unlisten 清理；bypass ref 在取消后要复位；macOS Cmd+Q 与红点关闭都要触发（onCloseRequested 两者都走，实测确认）。
