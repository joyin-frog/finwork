# 技能页改造为卡片首页 + 详情二级页 Spec

> 版本 v1.0 / 2026-07-04
> 状态：已批准
> 依赖：无
> 架构事实：
> - `/skills` 当前是单页两栏布局（`app/skills/skills-manager.tsx` 里的 `SkillsManager`）：左侧 `w-72` 技能列表（含搜索、启停开关），右侧是选中技能的编辑器（`SkillEditor`：文件树 + Markdown 源码/渲染切换 + 保存/删除），全部在同一个 client 组件内用 `useState` 切换，不改 URL。
> - 技能数据源：`GET /api/skills` 返回 `SkillSummary[]`；`GET /api/skills/[name]` 返回单个 `SkillDetail`（= `SkillSummary` + `body`，详见 `lib/agent/skills-store.ts`）；文件级操作走 `/api/skills/[name]/files` 系列路由，均已存在、本次不改动。
> - `SkillSummary` 字段（`lib/agent/skills-store.ts` L15-30）：`name`（主键）、`title`（展示名）、`summary`（一句话说明，给卡片用）、`requires`（建议准备材料）、`starter`（进对话时预填开场白）、`description`（给 LLM 判断用，不展示）、`source: "bundled"|"user"`、`editable`、`enabled`。
> - "进入对话"跳转机制未变：`<Link href="/chat/new?skill=${name}">`，`/chat/new/page.tsx` 已经会读 `?skill=` 拼 `initialDraft`（`/${name} ${starter}`），本次不改这条链路。
> - 之前（本会话更早一轮）把设置弹窗里的"技能"tab（`app/config/skill-catalog.tsx`，按使用场景分组的能力卡片 + "开始"按钮）整个删除，导致"选一个技能一键进对话"这个能力目前在全应用范围内没有任何入口——这正是本次要在 `/skills` 里恢复的能力。
> - `app/shared/app-nav.tsx` 主导航"技能"入口已经指向 `/skills`，本次不用改。
> - 参考视觉：`/files` 页（`app/files/page.tsx`）的卡片网格用 `grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3`；卡片组件 `app/shared/resource-card.tsx` 的视觉语言是 `rounded-lg border p-3` + hover 才显示的底部图标按钮（`opacity-0 group-hover:opacity-100`）——本次不复用 `ResourceCard` 本身（它的 props 是文件专属的 `mimeType`/`FileTypeIcon`），而是新写一个视觉语言一致但内容专属技能的 `SkillCard`。
> - `filterSkills()`（`app/skills/file-tree.ts` L73-79）已经是通用的按 name/title/description 模糊搜索函数，直接复用。

## 0. 目标与非目标

**目标**：把 `/skills` 从"一屏两栏（列表+编辑器）"改造成"卡片网格首页 + 技能详情二级页"两级结构：首页每个技能一张小卡片（标题+描述+来源标签），右上角搜索、支持 系统/个人 分类筛选；点卡片进入 `/skills/[name]` 详情页（= 现有的文件树+Markdown 编辑器，原样保留），详情页左上角有"返回"按钮回首页；同时恢复"一键进入对话"的能力——卡片 hover 出现快捷图标、详情页也有"开始对话"按钮，两处都跳 `/chat/new?skill=name`。

**非目标（本期不做，已知并接受）**：
- 不做 `CAPABILITY_GROUPS`（算薪窗口/报税期/结账出数/随时可用）那种按业务场景分组的二级分类，只做 系统/个人 这一层（因为它直接对应 `SkillSummary.source`，不需要额外维护一份硬编码映射；场景分组如果之后需要可以单开一轮）。
- 不改 `/api/skills/*` 任何后端路由的行为。
- 不改"新建技能"表单本身的字段和校验逻辑，只挪它挂载的位置（从"选中技能"的右栏，变成首页内联切换）。
- 不做卡片拖拽排序、收藏置顶等资料页可能有的高级列表功能。
- 搜索框做成常驻输入框（对齐本会话里刚做完的设置页搜索框视觉：无边框、图标+placeholder），不做资料页那种"点图标展开"的交互，因为用户只要求"有搜索（右侧）"，没要求这个展开动画。

## 1. 成功标准

- [ ] 访问 `/skills`：顶部是"技能"标题 + 右侧常驻搜索框（无边框，图标+placeholder"搜索技能..."）+ "新建"图标按钮；标题下方是 全部/系统/个人 三个筛选 chip；下方是卡片网格，每张卡片只有标题+描述（+来源标签），无文件树/编辑器内容。
- [ ] 卡片 hover 时右下角出现一个"进入对话"图标按钮，点击（无需先进详情页）直接跳转 `/chat/new?skill=<name>`，不触发进入详情页的导航。
- [ ] 点击卡片主体（非 hover 图标区域）跳转到 `/skills/<name>`。
- [ ] `/skills/<name>` 详情页：左上角有"← 返回"链接，点击回到 `/skills`（保留之前的搜索词/筛选状态——用浏览器原生返回栈即可，不用额外做状态持久化）；页面内容 = 现有 `SkillEditor` 的文件树 + Markdown 源码/渲染切换 + 保存/删除功能，一字不少地保留；顶部信息条新增：技能标题、来源标签、（如有）`requires` 文本、"开始对话"按钮（跳 `/chat/new?skill=name`）；用户技能（`source==="user"`）保留启停 `Switch`（从旧列表行搬到这里）。
- [ ] 直接在浏览器地址栏输入一个不存在的 `/skills/not-a-real-skill`，页面不崩溃，显示"技能不存在"+ 返回链接。
- [ ] "新建技能"功能保留：从首页点"新建"图标进入表单（替换卡片网格），提交成功后跳转到新建技能的 `/skills/<new-name>` 详情页；点"取消"回到卡片网格。
- [ ] 搜索框输入技能标题/name 关键字，卡片网格实时过滤（复用 `filterSkills`）；筛选 chip 切换 系统/个人/全部 同样实时过滤，两者可叠加。
- [ ] `e2e/mock/chat.spec.ts` 里"技能目录"那条用例改成访问 `/skills`（不再是 `/config?tab=skills`），改成先 hover/点击卡片上的"进入对话"图标按钮直接进入 `/chat/new?skill=payroll-calc`（不必先进详情页），其余断言（URL、输入框预填、发送带 referencedSkills）不变、必须跑绿。
- [ ] `npx tsc --noEmit`（排除 `tests/`、`.next/`）无新增错误；`node --import tsx tests/all.test.ts` 全绿（如果 `file-tree.ts` 的 `filterSkills` 有单测，确认签名没破坏）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/skills/skills-shared.tsx` | 新增 | 从旧 `skills-manager.tsx` 抽出的共享件：`SkillSource`/`SkillSummary`/`SkillFileEntry` 类型、`IconButton`、`SourceTag`、`api()`、`stripFrontmatter()`、`SKILL_NAME_RE` |
| `app/skills/skill-card.tsx` | 新增 | `SkillCard` 组件：标题+描述+来源标签的小卡片，hover 出"进入对话"图标按钮，整卡片可点(Link 到 `/skills/[name]`) |
| `app/skills/skills-manager.tsx` | 重写 | 从"两栏列表+编辑器"改成"卡片网格首页"：搜索框、系统/个人筛选 chip、`SkillCard` 网格、"新建"入口（复用现有 `NewSkillForm`，创建成功后 `router.push` 到详情页） |
| `app/skills/skill-editor.tsx` | 新增 | 从旧 `skills-manager.tsx` 里原样搬出 `SkillEditor` + `FileTreeView`（文件树/编辑/保存/删除，逻辑不变），供详情页使用 |
| `app/skills/[name]/page.tsx` | 新增 | 详情页路由：服务端读 `params.name`，渲染客户端 `SkillDetailPage`（下方新增） |
| `app/skills/[name]/skill-detail-page.tsx` | 新增 | 客户端组件：`fetch("/api/skills/{name}")` 拿 `SkillDetail`；404 显示"技能不存在"+返回链接；否则渲染 返回链接 + 顶部信息条（标题/来源/requires/开始对话按钮/用户技能启停开关/删除）+ `SkillEditor` |
| `e2e/mock/chat.spec.ts` | 修改 | "技能目录"用例改成访问 `/skills`，点卡片的"进入对话"图标而不是旧的"开始"文字链接 |
| `app/skills/page.tsx` | 确认/如需微调 | 继续 `import { SkillsManager } from "@/app/skills/skills-manager"` 渲染；重写后的 `skills-manager.tsx` **必须保留 `SkillsManager` 这个导出名和零 props 签名不变**，否则这个 import 会编译失败。这个文件本身内容大概率不用改（只渲染 `<SkillsManager />`），列进来是为了限定"导出名不能变"这条约束的检查点。 |

`app/skills/file-tree.ts`、所有 `/api/skills/*` 路由——不改。

## 3. 实施步骤

1. **`skills-shared.tsx`**：把现 `skills-manager.tsx` 里的 `SourceTag`（L59-71）、`IconButton`（L19-57）、`type SkillSource`/`SkillSummary`/`SkillFileEntry`（L73-75）、`SKILL_NAME_RE`（L77）、`stripFrontmatter`（L79-82）、`api<T>`（L84-88）原样剪切过去，加 `"use client"`，全部 `export`。**注意**：现有本地 `SkillSummary` 类型（L74）缺 `requires`/`starter` 两个字段（后端 `lib/agent/skills-store.ts` 的规范类型有，API 也会返回），而详情页头部信息条要读 `skill.requires` 渲染"需要准备："文本、"开始对话"要用到 `starter`（虽然只是拼 URL 不直接读，但类型要跟真实数据对齐）。剪切时把这两个字段补上：`{ name, title, summary, requires, starter, description, source, editable, enabled }`（不要设成可选 `?:`，后端两个字段都保证有值，同 `title`/`summary` 一样非 optional，保持类型一致不需要到处判空）。

2. **`skill-editor.tsx`**：把现 `skills-manager.tsx` 里的 `SkillEditor`（L266-440）和 `FileTreeView`（L443-520）原样剪切过去，顶部 import 改成从 `./skills-shared` 拿 `IconButton`/`SourceTag`/`api`/`stripFrontmatter`/`SkillSummary`/`SkillFileEntry`，从 `./file-tree` 拿 `buildFileTree`/`fileLang`（不变）。**`SkillEditor` 组件本身的 JSX/逻辑一行不改**——只是换文件、换 import 来源，因为这是"保留全部现有功能"的核心约束。

3. **`skill-card.tsx`**（新写，参照 `resource-card.tsx` 的视觉语言但内容专属技能）：
   ```tsx
   "use client";
   import Link from "next/link";
   import { useRouter } from "next/navigation";
   import { HugeiconsIcon } from "@hugeicons/react";
   import { BubbleChatAddIcon } from "@hugeicons/core-free-icons";
   import { SourceTag } from "@/app/skills/skills-shared";
   import type { SkillSummary } from "@/app/skills/skills-shared";
   import { cn } from "@/lib/utils";

   export function SkillCard({ skill }: { skill: SkillSummary }) {
     const router = useRouter();
     return (
       <Link
         href={`/skills/${encodeURIComponent(skill.name)}`}
         className={cn(
           "group relative flex flex-col gap-2 rounded-lg border p-3 transition-colors",
           "border-border hover:border-primary/40 hover:bg-accent/40",
           !skill.enabled && "opacity-60",
         )}
       >
         <div className="flex items-start justify-between gap-2">
           <div className="text-body font-medium line-clamp-2">{skill.title || skill.name}</div>
           <SourceTag source={skill.source} />
         </div>
         <p className="text-meta text-muted-foreground line-clamp-3">{skill.summary || skill.description}</p>
         <div className="flex justify-end pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
           <button
             type="button"
             title="进入对话"
             aria-label="进入对话"
             onClick={(e) => { e.preventDefault(); router.push(`/chat/new?skill=${encodeURIComponent(skill.name)}`); }}
             className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-accent transition-colors"
           >
             <HugeiconsIcon icon={BubbleChatAddIcon} size={14} />
           </button>
         </div>
       </Link>
     );
   }
   ```
   注意：外层用 `<Link>` 而不是 `<article onClick>`，这样"点卡片主体"天然是导航（SSR 可预取、可 cmd+click 新标签页），hover 图标按钮内部 `e.preventDefault()` 阻止触发外层 `<Link>` 的导航，改用 `router.push`（`next/navigation`）做 SPA 导航，不用 `window.location.href` 整页刷新。`line-clamp-2`/`line-clamp-3` 项目里如果没全局启用 `@tailwindcss/line-clamp` 插件要确认能用（`resource-card.tsx` L128 已经在用 `line-clamp-2`，说明插件已可用，直接抄）。

4. **`skills-manager.tsx` 重写**（网格首页，替换整个旧文件内容）：
   - state：`skills`、`query`、`category`("all"|"bundled"|"user")、`creating`。
   - `loadSkills` 逻辑不变（`GET /api/skills`）。
   - 顶部栏：`<h1>技能</h1>` + 常驻搜索 `<input>`（抄本次会话刚做的设置页搜索框样式：无 border、图标 `Search01Icon` 绝对定位在左，参考 `app/config/skill-center.tsx` 现在的搜索框 className）+ "新建"`IconButton`（复用 `skills-shared.tsx` 的 `IconButton`）。
   - 筛选 chip 行：`全部`/`系统`/`个人` 三个 `<button>`，选中态 `bg-accent text-accent-foreground`，未选中 `text-muted-foreground hover:bg-accent/60`（参照 `app/config/skill-center.tsx` 里 tab 列表按钮的 selected/unselected 二元写法，不用抄 `/files` 页那套多色 chip，保持简单）。
   - 列表过滤：`filterSkills(skills, query)` 之后再按 `category` 过滤（`category==="all" || s.source===category`）。
   - 网格：`<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-4">`，`visibleSkills.map(s => <SkillCard key={s.name} skill={s} />)`；`skills.length===0` 显示"加载中…"；过滤后为空显示"无匹配技能"。
   - `creating` 为真时，整个网格区域换成 `<NewSkillForm>`（原样保留，import 时把它也一并留在这个文件里或搬进 `skills-shared.tsx` 都行，建议留在 `skills-manager.tsx` 内因为只有首页用得到）；`onCreated` 回调改成：
     ```tsx
     onCreated={async (name) => { setCreating(false); router.push(`/skills/${encodeURIComponent(name)}`); }}
     ```
     需要 `useRouter()`（`next/navigation`），文件顶部加 `"use client"` + import。

5. **`app/skills/[name]/page.tsx`**（新增，server component）：
   > 路由自洽性说明：新建技能走首页内联表单（`setCreating(true)`），**不**访问 `/skills/new` 路由，因此 `[name]` 动态段不会与任何保留路径碰撞。若将来要给新建单开路由，需在 `app/skills/new/` 建静态段（静态段优先级高于 `[name]`），本期不涉及。
   ```tsx
   import { SkillDetailPage } from "./skill-detail-page";

   export const dynamic = "force-dynamic";

   export default async function Page({ params }: { params: Promise<{ name: string }> }) {
     const { name } = await params;
     return <SkillDetailPage name={name} />;
   }
   ```

6. **`app/skills/[name]/skill-detail-page.tsx`**（新增，client component）：
   - `"use client"`，props `{ name: string }`。
   - `useEffect` 里 `fetch("/api/skills/" + encodeURIComponent(name))`，存 `skill: SkillDetail | null`、`notFound: boolean`、`loading: boolean` 三个 state。
   - `notFound` 时渲染：
     ```tsx
     <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
       <p>技能不存在</p>
       <Link href="/skills" className="text-primary hover:underline">← 返回</Link>
     </div>
     ```
   - 正常时渲染：
     ```tsx
     <div className="h-full flex flex-col">
       <div className="flex items-center gap-3 px-4 h-11 shrink-0 border-b border-border">
         <Link href="/skills" className="flex items-center gap-1 text-body text-muted-foreground hover:text-foreground transition-colors">
           <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
           返回
         </Link>
         <span className="text-title font-semibold">{skill.title || skill.name}</span>
         <SourceTag source={skill.source} />
         {skill.requires && <span className="text-meta text-muted-foreground">需要准备：{skill.requires}</span>}
         <div className="flex-1" />
         {skill.source === "user" && (
           <Switch checked={skill.enabled} onCheckedChange={(v) => void toggleEnabled(v)} aria-label={skill.enabled ? "停用" : "启用"} />
         )}
         <Button asChild size="sm">
           <Link href={`/chat/new?skill=${encodeURIComponent(skill.name)}`}>开始对话</Link>
         </Button>
       </div>
       <div className="flex-1 min-h-0">
         <SkillEditor
           key={skill.name}
           skill={skill}
           onDeleted={() => router.push("/skills")}
         />
       </div>
     </div>
     ```
     `toggleEnabled` 直接照抄旧 `skills-manager.tsx` L106-118 的 `PATCH /api/skills/{name}` 乐观更新逻辑，落地到这个文件里（本地 state 更新 `skill.enabled` 而不是数组）。
   - `SkillEditor` 的 `onDeleted` 现在要做路由跳转（旧版是 `setSelected(null)`），改成 `router.push("/skills")`（`useRouter` from `next/navigation`）。
   - 注意 `SkillEditor` 自己的顶栏（L358-363，"删除技能"按钮那行）在新详情页里会和这里新加的头部信息条**重复**（都显示技能名/来源/删除）——**实施时要把 `SkillEditor` 自己内部那行顶栏删掉**（连同它自己的 `deleteSkill`/`IconButton`删除按钮一起挪到 `skill-detail-page.tsx` 的头部信息条里），避免详情页出现两条几乎一样的标题栏。也就是说 `SkillEditor` 组件签名要加一个可选的"是否显示自带头部"或者干脆把 L356-363 这段头部 JSX 从 `SkillEditor` 里整体删掉，`onDeleted`/`skill.editable` 相关的删除按钮和 `deleteSkill()` 函数搬到 `skill-detail-page.tsx`（`skill-detail-page.tsx` 需要自己实现一次 `deleteSkill`，逻辑照抄旧 L348-353）。
     **决策**：为了不把 `SkillEditor` 改得面目全非（第 2 步说"一行不改"），改成这样分工：`SkillEditor` 保留自己的 L365 开始的"文件树+内容"两栏（`<div className="flex-1 flex min-h-0">` 那部分不变），但删掉 L357-363 那段自带顶栏（技能名+来源+删除按钮），`onDeleted` prop 保留（文件树里如果将来有别的删除触发点可以继续用，当前没有可以留空占位）；删除按钮和 `deleteSkill()` 逻辑整个挪到 `skill-detail-page.tsx` 的头部信息条里（第 6 步已经画出来了）。这样"第 2 步一行不改"的表述改成"除了顶部 L357-363 那段顶栏整体删除之外，其余逻辑一行不改"。

7. **`e2e/mock/chat.spec.ts`** "技能目录"用例改写：
   ```ts
   test("skills catalog: 开始 → 新聊天技能已钉 → 发送携带技能", async ({ page }) => {
     await page.goto("/skills", { waitUntil: "domcontentloaded" });
     const payrollCard = page.locator('a[href="/skills/payroll-calc"]');
     await expect(payrollCard).toBeVisible();
     // 卡片上的「进入对话」图标按钮靠 group-hover:opacity-100 才可见,Playwright 不会自动 hover,
     // 必须先 hover 卡片再点按钮,否则会因元素视觉不可见而点击失败。
     await payrollCard.hover();
     await payrollCard.getByRole("button", { name: "进入对话" }).click();

     await expect(page).toHaveURL(/\/chat\/new\?skill=payroll-calc/);
     // ...其余不变（box focus/value、发送、referencedSkills、核对完成)
   });
   ```
   用 `a[href="/skills/payroll-calc"]` 精确定位卡片（避免整卡片文本里同时含标题和描述导致 `getByRole("link", { name: ... })` 的可访问名匹配产生歧义）。

## 4. 测试与验证方式

纯前端改动，不涉及 Python 侧。

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/practical-liskov-301d5e
npx tsc --noEmit 2>&1 | grep -v "^tests/" | grep -v "^\.next/" | grep "error TS"   # 应为空
node --import tsx tests/all.test.ts   # 全绿

# e2e(需要先起 mock server)
rm -rf .claude/e2e-mock/appdata
FINANCE_AGENT_APP_DATA_DIR=.claude/e2e-mock/appdata FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_SECRET_BACKEND=file npx next dev -p 3997 &
# 等端口起来后:
BASE_URL=http://127.0.0.1:3997 npx playwright test e2e/mock/chat.spec.ts --reporter=list
```

- 需要新增的测试：无新增单测文件；`e2e/mock/chat.spec.ts` 里那条既有用例按第 3.7 步改写即可覆盖新流程。
- 手动验证（用 preview 工具在浏览器里走一遍，因为这是纯 UI 改动，自动化测试证明不了视觉是否合理）：
  1. 打开 `/skills`，确认卡片网格、搜索、系统/个人筛选都能用。
  2. hover 一张卡片，点右下角图标，确认直接跳 `/chat/new?skill=xxx`（不经过详情页）。
  3. 点卡片主体，进 `/skills/xxx` 详情页，确认返回按钮、开始对话按钮、文件树编辑器都还在且能用（尤其检查一个内置技能=只读、一个用户技能=可编辑两种情况都点一遍）。
  4. 手输 `/skills/not-a-real-skill`，确认显示"技能不存在"而不是白屏/崩溃。
  5. 点"新建"，建一个技能,确认创建后跳到它的详情页；回首页确认新卡片出现在"个人"分类里。

## 5. 风险与开放问题

- `SkillEditor` 挪走自带顶栏后，`onDeleted`/`skill.editable` 相关 prop 是否还需要保留在 `SkillEditor` 签名里——保留但暂时用不上也没关系（不算死代码，因为 prop 仍由调用方注入，只是这次删除触发点换了地方）；如果 implementer 发现 `SkillEditor` 内部完全不再引用 `onDeleted`，直接把这个 prop 从签名里去掉，改成非 prop（`skill-detail-page.tsx` 自己处理删除+跳转），不要为了"保留 prop 接口不变"而留一个没人调用的参数。
- `SkillCard` 用 `<Link>` 包整个卡片、内部再放一个会 `preventDefault` 的按钮，这个模式要注意按钮本身不能是嵌套的 `<a>`（HTML 不允许 a 套 a），当前设计按钮是 `<button>`，没问题。
- `line-clamp-2`/`line-clamp-3` 依赖 Tailwind 的 `-webkit-line-clamp` 工具类，`resource-card.tsx` 已经在用，说明项目 Tailwind 版本/配置支持，无需额外确认。
- 详情页 `GET /api/skills/{name}` 404 时的错误态需要处理"技能名格式不合法"（`isValidSkillName` 返回 false）和"技能不存在"两种 400/404，都统一显示"技能不存在"文案即可，不需要分别处理。
