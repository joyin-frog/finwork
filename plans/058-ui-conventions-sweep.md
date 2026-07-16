# Plan 058: UI 约定清扫——文案/焦点环/disabled/间距/高亮色/空态/表单标签八项对齐

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- app/ lib/knowledge/shared.ts`
> 若清单里任何一处的现状与「Current state」不符，跳过该处并在 audit 里记录，不算 STOP（本计划是多点位清扫，单点漂移不阻塞其余）。

## Status

- **Priority**: P2
- **Effort**: M（点位多但每处极小）
- **Risk**: LOW
- **Depends on**: 与 plan 053/054/055 有同文件交集（knowledge/page.tsx、app-nav.tsx）——**先执行 053/054/055，本计划最后做**，避免冲突
- **Category**: tech-debt（UI 约定）
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

`docs/ui-conventions.md` 是仓库的界面法律；审计发现八类违规共 ~20 个点位：无信息量的错误 toast（约定点名禁止的原话）、手动去 outline 导致键盘焦点不可见（a11y 实伤）、disabled 透明度三种值、ASCII `...`、调色板黄高亮不随主题、跳出 4px 节奏的间距、「暂无对话」空态不指向动作、财务字段输入框对读屏匿名。单个都小，合起来让约定失去权威。一次清扫全部对齐。

## Current state（逐点清单，执行时逐条打勾）

先读 `docs/ui-conventions.md` 全文（约定原文）。以下每条给出位置与现状：

**A. 错误 toast 文案（约定：错误=发生了什么+下一步；禁「操作失败，请重试」）**
- A1 `app/components/checklist-card.tsx:148,152` — `toast.error("更新失败，请重试")`（两处：`!res.ok` 分支与 catch）。改：`"清单项没有更新成功。检查网络后重试"`（148 行 `!res.ok` 可更具体：读该函数上下文，若有 res.status 可用则区分）。
- A2 `app/components/ask-user-panel.tsx:67` — `toast.error("提交失败,请重试")`。改：`"回答没有提交成功。检查网络后重新选择"`。
- A3 `app/components/ask-user-card.tsx:53,56` — `toast.error("确认提交失败，请重试")`。改：`"确认没有提交成功。检查网络后再点一次"`。
- A4 `app/chat/chat-page.tsx:392` — fallback `"处理出错,请重试"`（它已带 description「已为你还原刚才的输入,按回车即可重试」——**保留现状**，此处 description 已给下一步，仅把主文案改为 `"这次回复没有完成"`）。

**B. 手动去 outline（约定：焦点环由全局 outline-ring/50 提供，不手动去）**
- B1 `app/chat/components/assistant-turn.tsx:554` — 反馈输入框 `outline-none` 且无任何 focus ring → 键盘焦点完全不可见。删掉 `outline-none`。
- B2 `app/shared/app-nav.tsx:210` — 重命名输入框 `outline-none focus:ring-1 focus:ring-ring`。删掉这三个类，交给全局环。
- B3 `app/knowledge/page.tsx:117` — 元数据输入框 `focus:outline-none focus:ring-1 focus:ring-ring`。同 B2 删。
- 验证方式：改后浏览器里 Tab 到该输入框应有可见 ring（全局 `@layer base` 的 `outline-ring/50`）；若视觉上环形与输入框圆角冲突严重，允许改用 `focus-visible:ring-1 focus-visible:ring-ring`（focus-visible 而非 focus），并在 audit 说明。

**C. disabled 态（约定：`disabled:opacity-50 disabled:pointer-events-none`）**
- C1 `app/chat/find-in-chat.tsx:221,229` — `disabled:opacity-40` ×2 → 改 50，补 `disabled:pointer-events-none`。
- C2 `app/skills/skill-card.tsx:37` — `disabled:opacity-40`（已有 pointer-events-none）→ 改 50。
- C3 `app/knowledge/page.tsx:951` — `disabled:opacity-60` → 改 50（该处 label/div 已带 `disabled:cursor-not-allowed` 与 hover 还原类，保留）。

**D. ASCII 省略号（约定：进行中用「…中」，省略号用 … 字符）**
- D1 `app/files/page.tsx:618` — `正在加载...` → `正在加载…`
- D2 `app/knowledge/page.tsx:712` — `加载中...` → `加载中…`
- D3 `app/chat/chat-file-browser.tsx:204` — `正在查找可打开的应用...` → `正在查找可打开的应用…`
- 收尾 grep：`grep -rn '\.\.\.' app --include="*.tsx" | grep -v "\.\.\.rest\|\.\.\.props\|spread"`——只处理**中文 UI 文案**里的 `...`，代码 spread 语法勿动；`app/e2e-preview/` 测试页勿动。

**E. 调色板色高亮（约定：交互/语义色一律语义 token）**
- E1 `lib/knowledge/shared.ts:75` — `<mark className="bg-yellow-200/70 dark:bg-yellow-500/30 ...">`。改用 tone token：先 `grep -n "tone-notice\|--tone" app/globals.css` 确认可用 tone 名，再改为形如 `bg-[color:var(--tone-notice)]/25 text-inherit rounded-sm`（写法参照仓库现有 tone 用法：`grep -rn "tone-ok\|tone-notice" app/ | head -5` 抄现成形式）。若 globals.css 无 notice/警示黄 tone，则在 STOP 前先确认是否有语义等价 token；实在没有 → 该点记录跳过（不擅自新增 token，token 新增是设计决策）。

**F. 间距节奏（约定：gap 走 1/2/3/4/6/8；不写任意值）**
- F1 `app/agents/agent-detail-drawer.tsx:130` — `gap-5` → 语义上是卡片内任务项列表 → `gap-4`。
- F2 `app/agents/task-board.tsx:268` — `gap-5` → 板块级 → `gap-6`。
- F3 `app/agents/page.tsx:221` — `gap-5`（页面内容列）→ `gap-6`。
- F4 `app/shared/global-shortcuts.tsx:168` — `gap-5`（快捷键面板列）→ `gap-4`。
- F5 `app/shared/first-run-gate.tsx:169` — `gap-5`（引导浮层列）→ `gap-6`。
- F6 `app/agents/agent-detail-drawer.tsx:73` — `px-[14px]` → 看该行注释与相邻面板（preview-head-card）对齐关系，取 `px-3` 或 `px-4` 中视觉更贴近者（默认 `px-4`）。
- F1–F5 改后在浏览器里扫一眼相邻兄弟元素的间距层级（组内<组间<区块间），若某处改完与同级 gap 冲突（如同容器混 4/6），以「同级统一」为准微调，并记录。

**G. 空态指向动作（约定：空状态指向第一个动作）**
- G1 `app/shared/app-nav.tsx:358` — `暂无对话` → `还没有对话。点上方「开启新对话」开始`（按钮名先 grep app-nav 里新建按钮的 aria-label/文案，引用真实名称；保持单行、`text-meta text-muted-foreground` 现有类不变）。注意 plan 053 会在同区域加「加载失败重试」分支——本计划改的是 `loaded && !loadError && length===0` 的分支文案。

**H. 表单标签（a11y：财务字段输入框需可编程关联标签）**
- H1 `app/knowledge/page.tsx:112-127` — 元数据编辑的 `.map(({ label, key }) => ...)`：`<span>` 改 `<label htmlFor={\`meta-${key}\`}>`（原 className 保留），`<input>` 加 `id={\`meta-${key}\`}`。注意该 input 行上方有 `eslint-disable-next-line no-restricted-syntax`——保留该注释原位置（在 label 改动中别把它挪离 input）。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error             |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0`（suppress-lock 计数用例若因 eslint-disable 增删失败，按其文件内注释调上限并记录） |
| e2e（可选）| `npm run test:e2e`      | journeys pass |

## Scope

**In scope**（仅上述清单点位所在文件）：
`app/components/checklist-card.tsx` · `app/components/ask-user-panel.tsx` · `app/components/ask-user-card.tsx` · `app/chat/chat-page.tsx`（仅 392 行文案） · `app/chat/components/assistant-turn.tsx`（仅 554 行类名） · `app/shared/app-nav.tsx`（210 行类名 + 358 行文案） · `app/knowledge/page.tsx`（117/712/951/112-127 四点） · `app/chat/find-in-chat.tsx` · `app/skills/skill-card.tsx` · `app/files/page.tsx`（618 行） · `app/chat/chat-file-browser.tsx`（204 行） · `lib/knowledge/shared.ts`（75 行） · `app/agents/agent-detail-drawer.tsx`（73/130 行） · `app/agents/task-board.tsx`（268 行） · `app/agents/page.tsx`（221 行） · `app/shared/global-shortcuts.tsx`（168 行） · `app/shared/first-run-gate.tsx`（169 行）

**Out of scope**:
- `app/globals.css`（不新增 token）；`docs/ui-conventions.md`（不改法律本身）。
- `app/e2e-preview/`。
- 每个点位所在文件的**其他任何行**——这是清扫不是重构。

## Git workflow

- Branch: `advisor/058-ui-conventions-sweep`
- Commit 建议按类分组提交：`style(ui): 错误文案对齐约定` / `style(ui): 焦点环与 disabled 态` / `style(ui): 间距、省略号、高亮与空态` / `fix(a11y): 知识库元数据输入框标签关联`
- 不 push、不开 PR。

## Steps

### Step 1: A 组（文案）→ Step 2: B+C 组（焦点/disabled）→ Step 3: D+E 组（省略号/高亮）→ Step 4: F 组（间距）→ Step 5: G+H 组（空态/标签）

每组完成后：

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 6: 全量回归 + 收尾 grep

**Verify**:
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`
- `grep -rn "请重试\"" app/components/ | grep -v "后重试\|再点\|重新"` → 无「纯请重试」残留
- `grep -rn "disabled:opacity-40\|disabled:opacity-60" app/` → 无命中
- `grep -rn "bg-yellow" app/ lib/` → 无命中（或仅 E1 记录的跳过项）
- `grep -rn "gap-5" app --include="*.tsx"` → 无命中

## Test plan

视觉/文案清扫无单测；以 Step 6 的 grep 门 + lint/typecheck + e2e 回归为准。B 组改动需浏览器手验一次 Tab 焦点可见（audit 记录）。

## Done criteria

- [ ] Step 6 全部 grep 门通过
- [ ] 清单 A–H 每条要么完成、要么在 audit 标注「跳过+原因」（漂移/E1 无对应 token）
- [ ] typecheck / lint / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 同一文件与 plan 053/054/055 的未合并改动冲突（本计划应最后执行；若先跑了，冲突处跳过并记录）。
- B 组删类后全局焦点环在该输入框上**不出现**（说明全局层有例外）——该点回退并记录，不要自造 ring。
- suppress-lock 之外的测试失败两次。

## Maintenance notes

- 「原生对话框/焦点环/失败态」等本轮教训值得沉淀进 docs/ui-conventions.md——留给维护者，本计划不改文档。
- Reviewer 看点：diff 里每一行都能对应清单某条；无顺手重排/格式化。
