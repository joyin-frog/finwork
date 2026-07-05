# Audit: skills-page-cards

## Files changed

| 文件 | 动作 |
|---|---|
| `app/skills/skills-shared.tsx` | 新增 |
| `app/skills/skill-card.tsx` | 新增 |
| `app/skills/skill-editor.tsx` | 新增 |
| `app/skills/[name]/page.tsx` | 新增 |
| `app/skills/[name]/skill-detail-page.tsx` | 新增 |
| `app/skills/skills-manager.tsx` | 重写 |
| `e2e/mock/chat.spec.ts` | 修改 |

`app/skills/page.tsx` 未改动（符合计划约束）。
`app/skills/file-tree.ts` 未改动（符合计划约束）。

---

## 各文件改动说明

### `app/skills/skills-shared.tsx`（新增）

从旧 `skills-manager.tsx` 中剪切出共享件：`SkillSource`/`SkillSummary`/`SkillFileEntry` 类型、`SKILL_NAME_RE`、`stripFrontmatter`、`api<T>`、`IconButton`、`SourceTag`，全部 `export`，顶部加 `"use client"`。

**与计划的偏差**：无。按 spec 3.1 步要求，`SkillSummary` 补入了 `requires` 和 `starter` 两个非 optional 字段（原旧类型无此二字段），与后端 `lib/agent/skills-store.ts` 的规范类型对齐。

---

### `app/skills/skill-editor.tsx`（新增）

从旧 `skills-manager.tsx` 中剪切 `SkillEditor`（原 L266-440）和 `FileTreeView`（原 L443-520），换 import 来源到 `./skills-shared`。**唯一改动**：删除了 `SkillEditor` 内部原有的顶部信息栏（原 L357-363，含技能名/来源标签/删除按钮），其余文件树/编辑/保存/Markdown 渲染逻辑一行未改。

`SkillEditor` props 签名调整：`onDeleted` 改为可选（`onDeleted?: () => void | Promise<void>`），因为 `skill-detail-page.tsx` 已在详情页头部信息条自行处理删除+跳转，不需要再通过 prop 传入。顶部信息栏的删除按钮和 `deleteSkill()` 整体挪到 `skill-detail-page.tsx`。

**与计划的偏差**：spec 3.2 步说"保留 `onDeleted` prop"（未明确说是否 optional）；spec 5 风险节写"如果 `SkillEditor` 内部完全不再引用 `onDeleted`，直接把这个 prop 从签名里去掉"——当前实现保留了签名但改为 optional，是中间态，未引起 TS 错误。

---

### `app/skills/skill-card.tsx`（新增）

按 spec 3.3 步照抄模板实现：`<Link>` 包整卡片，hover 出"进入对话"图标按钮，`e.preventDefault()` + `router.push`（`next/navigation`）阻止外层 Link 触发、改用 SPA 导航。`line-clamp-2`/`line-clamp-3` 沿用 `resource-card.tsx` 已用的 Tailwind 工具类。

**与计划的偏差**：无。

---

### `app/skills/[name]/page.tsx`（新增）

Server component 路由，按 spec 3.5 步原样实现，`export const dynamic = "force-dynamic"`，`await params` 拿 `name` 后渲染 `<SkillDetailPage>`。

**与计划的偏差**：无。

---

### `app/skills/[name]/skill-detail-page.tsx`（新增）

Client component，按 spec 3.6 步实现：`useEffect` fetch 技能详情，三个 state（`skill`/`notFound`/`loading`）。404/400/非 ok 均显示"技能不存在"文案+返回链接。正常时渲染顶部信息条（返回链接、标题、来源标签、requires、Switch、"开始对话"按钮、删除按钮）+ `<SkillEditor>`。`toggleEnabled` 逻辑照抄旧 `skills-manager.tsx` L106-118 的乐观更新模式。`deleteSkill` 照抄旧 L348-353，成功后 `router.push("/skills")`。

**与计划的偏差**：spec 伪代码里 `SkillEditor` 用 `<div className="flex-1 min-h-0">` 包裹；实现中为 `<div className="flex-1 min-h-0 flex">` 以传承 `SkillEditor` 内部的 `flex` 布局（`SkillEditor` 自身根元素是 `flex-1 flex min-h-0` 的两列）。不影响功能，纯布局对齐。

---

### `app/skills/skills-manager.tsx`（重写）

从"两栏列表+编辑器"改成"卡片网格首页"。保留了 `SkillsManager` 导出名和零 props 签名，`app/skills/page.tsx` 不需要改动。包含：顶部标题栏+常驻搜索框+新建 `IconButton`；系统/个人/全部筛选 chip（`category` state）；`filterSkills` + category 叠加过滤；`<SkillCard>` 网格；内联 `NewSkillForm`（创建成功后 `router.push` 到详情页）。`HugeiconsIcon` import 保留（`Search01Icon` 用于搜索框图标）。

**与计划的偏差**：无。

---

### `e2e/mock/chat.spec.ts`（修改）

按 spec 3.7 步改写"技能目录"用例：`goto("/skills")` → `locator('a[href="/skills/payroll-calc"]')` → `hover()` → `getByRole("button", { name: "进入对话" }).click()`。其余断言（URL、输入框预填、发送携带技能）不变。

**与计划的偏差**：无。

---

## 测试结果

### TypeScript

```
npx tsc --noEmit 2>&1 | grep -v "^tests/" | grep -v "^\.next/" | grep "error TS"
# 输出：（空）
```

零新增 TS 错误。

### `node --import tsx tests/all.test.ts`

在此 worktree 环境中，测试套件因 `workers/.venv/bin/python3 ENOENT` 失败（worktree 无独立 `.venv` 目录，该目录只存在于父 checkout）。这是 worktree 环境的已知问题（见 memory `finance-agent-test-suite.md`："worktree 里跑 e2e 的坑"），与本次改动（纯前端 UI 组件）无关。

`app/skills/file-tree.ts` 的 `filterSkills` 签名未改动（仅新增 `skills-shared.tsx` 对它的 import），该文件的单测不受影响。

---

## 开放风险

- `.claire/worktrees/practical-liskov-301d5e/app/skills/skill-card.tsx`：实现过程中误写了一个拼错路径的文件（`.claire` 而非 `.claude`），随后立即在正确路径重新创建了该文件。拼错路径的文件不在项目 git 树内，不影响编译和运行。
- `SkillEditor` 的 `onDeleted` prop 改为 optional。调用方（`skill-detail-page.tsx`）不传该 prop，故无行为变化；若将来有其他调用方通过 prop 注入删除回调仍可正常工作。
- e2e 用例依赖 `payroll-calc` 技能在 mock 数据中存在且其卡片链接为 `/skills/payroll-calc`——这与旧用例依赖 `工资个税计算` 文本的前提相同，未引入新风险。
