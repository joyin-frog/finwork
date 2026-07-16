# Plan 054: 替换全部原生 window.confirm / window.prompt 为应用内对话框

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- "app/skills/[name]/skill-detail-page.tsx" app/skills/skill-editor.tsx app/agents/agent-detail-drawer.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug（桌面端可用性）+ UI 一致性
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

四处破坏性/输入型交互用了浏览器原生对话框。在 Tauri 的 WebView（macOS WKWebView / Windows WebView2）里，原生 `confirm`/`prompt` 可能渲染在窗口后面或被完全抑制——**桌面版这些流程可能直接失效**（删技能、删技能文件、新建技能文件、锁定复核）。即使显示出来，也不走主题、不符合「按钮=动词+宾语」的文案约定。应用已有现成的 `ConfirmDialog` 组件，替换是纯落地工作。此外智能体抽屉的锁定操作把网络失败静默吞掉，一并修。

## Current state

四个调用点（原样摘录）：

1. `app/skills/[name]/skill-detail-page.tsx:54`
   `if (!window.confirm(\`删除技能「${skill.name}」?此操作不可撤销。\`)) return;`
2. `app/skills/skill-editor.tsx:82`
   `const rel = window.prompt("新文件相对路径(如 scripts/run.py):");`
3. `app/skills/skill-editor.tsx:94`
   `if (!window.confirm(\`删除文件 ${rel}?\`)) return;`
4. `app/agents/agent-detail-drawer.tsx:46-56`（裸 `confirm(`，且失败静默）：

```ts
  const handleLock = useCallback(async (dispatchId: number) => {
    if (!confirm("确认锁定该任务的复核状态？锁定后不可撤销。")) return;
    try {
      const res = await fetch(`/api/agents/dispatches/${dispatchId}/lock`, { method: "POST" });
      if (res.ok) {
        setLockedIds((prev) => new Set(prev).add(dispatchId));
      }
    } catch {
      // 网络错误：静默忽略（用户可刷新重试）
    }
  }, []);
```

- 现成组件 `app/shared/confirm-dialog.tsx`（25 行起）：`ConfirmDialog({ open, onOpenChange, title, description?, confirmLabel?, cancelLabel?, destructive?, onConfirm })`，基于 Radix AlertDialog。使用范例：`grep -n "ConfirmDialog" app/knowledge/page.tsx`（deleteTarget state + 组件）——**照这个模式写**。
- 文案约定（docs/ui-conventions.md）：危险按钮直说动作（「删除技能」「删除文件」「锁定任务」）；错误=发生了什么+下一步；中文标点（现有 `?` 应为 `？`，随手在新文案里用全角）。
- prompt 替换：`components/ui/` 下有 shadcn Dialog / Input（`ls components/ui | grep -i "dialog\|input"` 核对可用组件名）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |

## Scope

**In scope**:
- `app/skills/[name]/skill-detail-page.tsx`
- `app/skills/skill-editor.tsx`
- `app/agents/agent-detail-drawer.tsx`

**Out of scope**:
- `ConfirmDialog` 组件本身。
- 技能删除/文件删除的服务端逻辑。
- 抽屉其他交互。

## Git workflow

- Branch: `advisor/054-native-dialogs`
- Commit：`fix(ui): 原生 confirm/prompt 替换为应用内对话框（Tauri 兼容）`
- 不 push、不开 PR。

## Steps

### Step 1: 删除技能（skill-detail-page）

加 `const [deleteOpen, setDeleteOpen] = useState(false);`；原按钮 onClick 改 `setDeleteOpen(true)`；渲染 `<ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={\`删除技能「${skill.name}」？\`} description="此操作不可撤销。" confirmLabel="删除技能" destructive onConfirm={原删除函数} />`。原 `window.confirm` 行删除。

**Verify**: `npm run typecheck` → exit 0

### Step 2: 删除文件（skill-editor:94）

同模式：`deleteFileTarget: string | null` state；`ConfirmDialog` `title={\`删除文件 ${rel}？\`}` `confirmLabel="删除文件"` `destructive`。

**Verify**: `npm run typecheck` → exit 0

### Step 3: 新建文件路径（skill-editor:82）

用受控小对话框替换 `window.prompt`：`newFileOpen` + `newFilePath` state，Dialog 内一个 `<Input placeholder="scripts/run.py" />` + 「创建文件」按钮（Enter 提交、Esc 关闭随 Dialog 默认）。提交后走原有的创建逻辑（含原有的路径校验，若校验在 prompt 之后——把它保留在提交处理器里）。若 `components/ui` 无独立 Dialog 原语可用，允许用 ConfirmDialog + description 里放 Input 的变体，但优先标准 Dialog。

**Verify**: `npm run lint` → 0 error

### Step 4: 锁定复核（agent-detail-drawer）

- `confirm(...)` → `ConfirmDialog`（`lockTarget: number | null` state；`title="锁定该任务的复核状态？"` `description="锁定后不可撤销。"` `confirmLabel="锁定任务"`）。
- 失败不再静默：`!res.ok` 与 catch 都 `toast.error("锁定失败，请检查网络后重试")`（`sonner` 的 toast，按仓库统一 import）。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 5: 确认无残留

**Verify**: `grep -rn "window.confirm\|window.prompt\|[^.]confirm(" app/ --include="*.tsx" | grep -v ConfirmDialog` → 无命中（允许误报时人工核对每一行）

## Test plan

纯 UI 替换，无既有组件测试基建；回归：typecheck + lint + 全量单测 + （环境可跑时）`npm run test:e2e`。若 e2e 里有 dialog handler 依赖原生 confirm（`grep -rn "on('dialog'\|accept()" e2e/`），相应用例需改为点应用内按钮——那属于本计划 in-scope 的测试适配，允许改 `e2e/journeys.spec.ts` 对应断言。

## Done criteria

- [ ] Step 5 的 grep 无原生对话框残留
- [ ] 四个流程均出现应用内对话框，破坏性操作 `destructive` 样式 + 动词宾语按钮
- [ ] 锁定失败有 toast
- [ ] typecheck / lint / 单测（及 e2e，若可跑）全绿；`git status` 无 scope 外改动（e2e 适配除外）；`plans/README.md` 已更新

## STOP conditions

- `ConfirmDialog` API 与摘录不符（漂移）。
- skill-editor 的新建文件逻辑里 prompt 返回值被多处使用、重构面超出该函数——报告。
- e2e 适配触及 2 个以上 spec 文件——停下报告。

## Maintenance notes

- 今后新增破坏性操作一律用 `ConfirmDialog`；「原生对话框在 Tauri 不可靠」值得写进 docs/ui-conventions.md（本计划不改文档，留给维护者）。
- Reviewer 看点：对话框关闭后焦点回归触发按钮（Radix 默认行为，别覆盖）。
