# 资料改名知识库 + 标签换位 + 技能搜索快捷键 + 技能分类 Spec

> 版本 v1.0 / 2026-07-05
> 状态：已批准
> 依赖：无（在 spec-skills-page-cards 完成的卡片首页基础上继续）
> 架构事实：
> - 主导航在 `app/shared/app-nav.tsx`。"资料"项在 L261-264：`<Link href="/files" onClick={() => trackFeature("nav.knowledge")} className={navLinkClass(active === "files" || active === "knowledge")}>` + `<span>资料</span>`。它的高亮已同时覆盖 `/files` 和 `/knowledge` 两个 active 值。
> - "对话文件 ｜ 知识库" 两个 tab 在独立组件 `app/shared/resource-tabs.tsx`：两个 `<Link>`（`/files`→"对话文件"、`/knowledge`→"知识库"）中间夹一个 `｜`，JSX 顺序即渲染顺序，无数组。`active: "files" | "knowledge"` 由各页面传入，与 JSX 顺序解耦。
> - 快捷键：纯函数内核在 `app/shared/shortcuts.ts`（`SHORTCUTS` 数组 + `resolveShortcut`），全局监听在 `app/shared/global-shortcuts.tsx`（`GlobalShortcuts` 组件 + `useShortcutEvent` hook + 一览弹窗 `ShortcutsHelpDialog` 的 `GROUPS`）。scope 化快捷键（chat/config）只在 `options.scope` 匹配时触发；`global-shortcuts.tsx` L60 按 pathname 前缀推 scope（`/chat`→chat、`/config`→config、其余 undefined）。设置页的 `search-settings`（mod+f, scope config）就是这套的现成范例：定义 shortcut → pathname 映射 → `resolveShortcut` 放行 → 落到 switch 的 default 分支 `dispatchEvent(SHORTCUT_EVENT,{id})` → 组件里 `useShortcutEvent(id, focusFn)` 接住。
> - `/skills` 卡片首页在 `app/skills/skills-manager.tsx`（最近重写）：搜索框是常驻 `<input>`，无 ref、无快捷键。分类筛选 chip 现为 `全部/系统/个人`，state `category: "all"|"bundled"|"user"`，过滤 `filterSkills(skills, query).filter(s => category === "all" || s.source === category)`。`filterSkills` 在 `app/skills/file-tree.ts` 是纯函数。
> - 技能数据层 `lib/agent/skills-store.ts`：`parseSkillMd`（L76-100）逐行解析 frontmatter 的 name/title/summary/requires/starter/description 六个键（`else if (key === "xxx")`），`ParsedSkill` 类型（L72）、`SkillSummary` 类型（L17-32）、summary 映射（L201 `return { name: s.name, ... }`）三处需同步。`serializeSkillMd`（L117）只写 name/description（用户新建技能时用），**不写 category**——这是有意的，用户技能默认无分类。`SkillDetail = SkillSummary & { body }` 自动继承新字段。
> - `app/skills/skills-shared.tsx` 里有一份前端用的 `SkillSummary` 类型（L12-22），与后端类型是两份独立定义，需同步加 category。
> - 12 个内置技能在 `agent-skills/skills/<name>/SKILL.md`。frontmatter 是标准 `---\nkey: value\n---` 格式，值支持裸标量或 JSON 双引号标量。
> - 测试：`e2e/mock/pages.spec.ts` L11 断言 `getByRole("link", { name: "资料" })` 可见（改名后会挂）。单测入口 `tests/all.test.ts` 汇总各测试文件导出的 promise，新测试文件要在这里注册。

## 0. 目标与非目标

**目标**：四件事一起做，全程 TDD（先改/加测试到红，再实现到绿）——
1. 主导航"资料"改名"知识库"，点击落到 `/knowledge`（知识库页），而非原来的 `/files`。
2. `resource-tabs.tsx` 里两个 tab 换位：知识库在前、对话文件在后。
3. `/skills` 技能页接上 Cmd/Ctrl+F 聚焦搜索框，效果与资料页一致（复用现有全局快捷键体系，scope="skills"）。
4. 技能加"分类"（数据层 frontmatter 驱动）：12 个内置技能分成 `财务`（8 个业务技能）与 `文件工具`（xlsx/pdf/docx/pptx）；技能页筛选 chip 从"全部/系统/个人"改成"全部/财务/文件工具/个人"。

**非目标（本期不做）**：
- 不给"新建技能"表单加分类选择器（用户技能默认无 category，落在 全部/个人 下；用户可自行在 SKILL.md 里写 `category:`，读取端会认）。
- 不改 `serializeSkillMd`（不为用户技能自动写 category）。
- 不在卡片上加分类小标签（分类通过筛选 chip 表达；卡片仍显示 系统/个人 的 `SourceTag`，避免双标签堆叠）。
- 不改 `/files`、`/knowledge`、`/skills` 的路由路径本身。
- 不动资料页内部的次级筛选 chip（全部/上传/生成/已保留）。

## 1. 成功标准

- [ ] 主导航第四项显示"知识库"，点击进入 `/knowledge`（知识库页，`ResourceTabs active="knowledge"`）；在 `/files` 和 `/knowledge` 下该导航项都高亮。
- [ ] `/files` 或 `/knowledge` 页顶部的 tab 顺序为「知识库 ｜ 对话文件」，当前页高亮正确（在 /knowledge 高亮"知识库"，在 /files 高亮"对话文件"）。
- [ ] 在 `/skills` 页按 Cmd+F（mac）/ Ctrl+F（win）聚焦并全选搜索框内容；该快捷键出现在"快捷键一览"弹窗和设置·键盘快捷键页里，描述"搜索技能"。
- [ ] `/skills` 筛选 chip 为「全部 / 财务 / 文件工具 / 个人」；点"文件工具"只剩 xlsx/pdf/docx/pptx 四张卡，点"财务"只剩 8 张业务卡，点"个人"只剩用户技能，"全部"显示所有；搜索框与 chip 可叠加过滤。
- [ ] 数据层：`getSkill("xlsx").category === "file-tool"`、`getSkill("payroll-calc").category === "finance"`；12 个内置 SKILL.md 各自 frontmatter 含正确的 `category:` 行。
- [ ] TDD 证据：新增/修改的单测在实现前是红的、实现后是绿的；`node --import tsx tests/all.test.ts` 全绿；`npx tsc --noEmit`（排除 tests/、.next/）无新增错误。
- [ ] e2e：`e2e/mock/pages.spec.ts` 导航断言更新为"知识库"并跑绿；其余既有 e2e 不回归。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/shared/app-nav.tsx` | 修改 | "资料"项：`href="/files"`→`href="/knowledge"`，`<span>资料</span>`→`<span>知识库</span>`（其余不动，高亮 class 已覆盖两页） |
| `app/shared/resource-tabs.tsx` | 修改 | 两个 `<Link>` 连同 `｜` 换位：知识库(/knowledge) 在前、对话文件(/files) 在后 |
| `app/files/page.tsx` | 修改 | L658 `title="资料预览"`→`title="文件预览"`（去掉"资料"字样，/files 就是对话文件） |
| `app/shared/shortcuts.ts` | 修改 | `ShortcutScope` 加 `"skills"`；`SHORTCUTS` 加 `search-skills`（mod+f, scope skills, allowInInput, webLimited）；`resolveShortcut` 的 scope 参数类型与 scope-skip 判断加 `"skills"` |
| `app/shared/global-shortcuts.tsx` | 修改 | L60 pathname→scope 加 `/skills`→"skills"；`GROUPS` 的 scope 联合类型与"全局与面板"数组加 `"skills"` |
| `app/config/shortcuts/shortcuts-settings.tsx` | 修改 | `GROUPS` 的 scope 联合类型与"全局与面板"数组加 `"skills"`（与 global-shortcuts 保持一致，否则设置页一览漏显 search-skills） |
| `app/skills/skills-manager.tsx` | 修改 | 搜索框加 `searchInputRef` + `useShortcutEvent("search-skills", 聚焦并 select)`；chip 改为 全部/财务/文件工具/个人，过滤改用 `filterByCategory` |
| `app/skills/skills-shared.tsx` | 修改 | 前端 `SkillSummary` 类型加 `category: string` |
| `app/skills/file-tree.ts` | 修改 | 新增纯函数 `filterByCategory`（供 skills-manager 用 + 单测） |
| `lib/agent/skills-store.ts` | 修改 | `ParsedSkill` + `SkillSummary` 类型加 `category`；`parseSkillMd` 解析 `category` 键并在两个 return 里带上；L201 summary 映射带上 `category` |
| `agent-skills/skills/xlsx/SKILL.md` 等 12 个 | 修改 | 各加一行 `category: file-tool`（xlsx/pdf/docx/pptx）或 `category: finance`（payroll-calc/reimbursement-check/kingdee-draft/finance-analysis/business-analysis/contract-extract/tax-incentive/rnd-deduction-check） |
| `tests/skills-category.test.ts` | 新增 | ①`filterByCategory` 纯逻辑单测 ②读 12 个 SKILL.md 断言各含正确 `category:` 行 |
| `tests/shortcuts.test.ts` | 修改 | **先修既有回归**：L103 碰撞 key `${s.scope === "composer" ? "composer" : "active"}:${s.combo}` → 改成 `${s.scope}:${s.combo}`（当前 find-in-chat(chat) 与 search-settings(config) 都是 mod+f，旧 key 把两者都算成 `active:mod+f` 已经误报冲突、测试当前是红的）；L112 数量上限 `<= 12` → `<= 14`（当前已 13 条，加 search-skills 后 14）。**再加新断言**：scope="skills"+mod+f 命中 search-skills；scope=undefined/chat 时不命中 search-skills；scope="skills" 时 find-in-chat 不命中 |
| `tests/all.test.ts` | 修改 | 注册 `tests/skills-category.test.ts` 的导出 promise |
| `e2e/mock/pages.spec.ts` | 修改 | L11 导航断言 `name: "资料"`→`name: "知识库"` |

## 3. 实施步骤（TDD：先测试到红，再实现到绿）

### 阶段 1 — 先写/改测试（应当变红）

1. **`tests/shortcuts.test.ts`**：
   - **先修既有回归（不修则测试一直红在错误的断言上）**：
     - L103 碰撞 key：`const key = \`${s.scope === "composer" ? "composer" : "active"}:${s.combo}\`;` → 改成 `const key = \`${s.scope}:${s.combo}\`;`。这样 chat:mod+f / config:mod+f / skills:mod+f 各自独立、不再误报；composer 条目仍按 `composer:combo`。同一 combo 跨 scope 是设计允许的（按页语义），dedup 只该防"同一 scope 内重复 combo"。
     - L112：`assert.ok(SHORTCUTS.length <= 12, ...)` → `assert.ok(SHORTCUTS.length <= 14, ...)`（当前 13 条，加 search-skills 后 14）。
   - **再加 resolveShortcut 新断言**（参照文件里既有 AC5 作用域断言的写法，用 `evt("f", { meta: true })` + `body`(非输入框) target）：
     - `resolveShortcut(evt("f",{meta:true}), body, { isMac:true, scope:"skills" })` 应返回 `"search-skills"`。
     - `resolveShortcut(evt("f",{meta:true}), body, { isMac:true })`（scope undefined）应返回 `null`（search-skills 不应在非 skills 页触发；此时 chat/config/skills 三个 mod+f 都被 scope-skip，全局里没有裸 mod+f，故 null）。
     - 在 `scope:"chat"` 下同一事件应返回 `"find-in-chat"`（验证跨 scope 不串），在 `scope:"skills"` 下应返回 `"search-skills"`（各归各页）。
   - search-skills 有 `allowInInput:true`，用 body（非输入框）target 即可命中，也可另加一条输入框 target 仍命中的断言（可选）。
2. **`tests/skills-category.test.ts`** 新建：
   ```ts
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";
   import path from "node:path";
   import { filterByCategory } from "../app/skills/file-tree.ts";

   export const skillsCategoryTestPromise = (async () => {
     // ① 纯逻辑
     const mk = (name: string, source: "bundled"|"user", category: string) => ({ name, source, category });
     const list = [mk("xlsx","bundled","file-tool"), mk("payroll-calc","bundled","finance"), mk("mine","user","")];
     assert.deepEqual(filterByCategory(list, "all").map(s=>s.name), ["xlsx","payroll-calc","mine"]);
     assert.deepEqual(filterByCategory(list, "file-tool").map(s=>s.name), ["xlsx"]);
     assert.deepEqual(filterByCategory(list, "finance").map(s=>s.name), ["payroll-calc"]);
     assert.deepEqual(filterByCategory(list, "user").map(s=>s.name), ["mine"]);

     // ② 数据:12 个内置 SKILL.md 的 category 正确
     const FILE_TOOL = ["xlsx","pdf","docx","pptx"];
     const FINANCE = ["payroll-calc","reimbursement-check","kingdee-draft","finance-analysis","business-analysis","contract-extract","tax-incentive","rnd-deduction-check"];
     const root = process.cwd();
     const readFm = (n: string) => readFileSync(path.join(root, "agent-skills/skills", n, "SKILL.md"), "utf8");
     for (const n of FILE_TOOL) assert.match(readFm(n), /^category:\s*file-tool\s*$/m, `${n} 应为 file-tool`);
     for (const n of FINANCE) assert.match(readFm(n), /^category:\s*finance\s*$/m, `${n} 应为 finance`);

     console.log("skills-category checks passed ✓");
   })();
   ```
   在 `tests/all.test.ts` 里 import 并 await 这个 promise（照抄该文件已有的注册模式）。
3. **`e2e/mock/pages.spec.ts`** L11：`name: "资料"` → `name: "知识库"`。

此时跑 `node --import tsx tests/all.test.ts` 应因 `filterByCategory` 未定义、SKILL.md 无 category、search-skills 未注册而**红**。

### 阶段 2 — 数据层与纯函数

4. **`lib/agent/skills-store.ts`**：
   - `ParsedSkill` 加 `category: string`。
   - `parseSkillMd`：加 `let category = "";`；循环里加 `else if (key === "category") category = decodeScalar(val);`；两个 return（无 frontmatter 的兜底 + 正常）都带上 `category`（兜底给 `""`）。
   - `SkillSummary` 类型加 `category: string;`（放在 source 附近，带注释"分类:finance/file-tool；用户技能默认空"）。
   - L201 映射加 `category: s.category`。
5. **`app/skills/skills-shared.tsx`**：前端 `SkillSummary` 加 `category: string;`（与后端一致，非可选）。
6. **`app/skills/file-tree.ts`** 加：
   ```ts
   /** 按分类 chip 过滤:all=全部;user=用户技能;其余按 category 精确匹配。 */
   export function filterByCategory<T extends { source: "bundled" | "user"; category: string }>(skills: T[], key: string): T[] {
     if (key === "all") return skills;
     if (key === "user") return skills.filter((s) => s.source === "user");
     return skills.filter((s) => s.category === key);
   }
   ```
7. **12 个 SKILL.md**：在每个文件 frontmatter 里加一行 `category: file-tool` 或 `category: finance`（裸标量即可，放在 `description` 之前或 `title` 之后都行，保持 frontmatter 合法）。逐个确认 name→category：file-tool = xlsx/pdf/docx/pptx；finance = payroll-calc/reimbursement-check/kingdee-draft/finance-analysis/business-analysis/contract-extract/tax-incentive/rnd-deduction-check。

跑单测：`filterByCategory` 与 SKILL.md 断言应转绿。

### 阶段 3 — 快捷键接线

8. **`app/shared/shortcuts.ts`**：
   - `ShortcutScope` 加 `"skills"`。
   - `SHORTCUTS` 末尾加：`{ id: "search-skills", combo: "mod+f", description: "搜索技能", scope: "skills", allowInInput: true, webLimited: true }`（附注释 `// ── 技能页 ──`）。
   - `resolveShortcut` 的 `options` 类型 `scope?: "chat" | "config"` → 加 `| "skills"`；scope-skip 判断 `if ((shortcut.scope === "chat" || shortcut.scope === "config") && ...)` → 加 `|| shortcut.scope === "skills"`。
9. **`app/shared/global-shortcuts.tsx`**：
   - L60 scope 三元：`... : currentPath.startsWith("/config") ? "config" : currentPath.startsWith("/skills") ? "skills" : undefined`。
   - `GROUPS` 的 scope 联合类型加 `"skills"`；"全局与面板"的 scopes 数组 `["global","chat","config"]` → 加 `"skills"`。
   - switch 无需加 case：`search-skills` 落 default 分支自动 `dispatchEvent`。
10. **`app/config/shortcuts/shortcuts-settings.tsx`**：`GROUPS` 的 scope 联合类型 + "全局与面板"数组同样加 `"skills"`。
11. **`app/skills/skills-manager.tsx`**：
    - import：`import { useShortcutEvent } from "@/app/shared/global-shortcuts";`、`import { useRef } from "react"`（已有 useState/useEffect，补 useRef）。
    - 组件内：`const searchInputRef = useRef<HTMLInputElement>(null);` + `useShortcutEvent("search-skills", () => { searchInputRef.current?.focus(); searchInputRef.current?.select(); });`
    - `<input>` 加 `ref={searchInputRef}`。

跑 `tests/shortcuts.test.ts` 应转绿。

### 阶段 4 — 分类筛选 UI

12. **`app/skills/skills-manager.tsx`**：
    - `type Category = "all" | "finance" | "file-tool" | "user";`
    - chips 数组：`[{ key:"all", label:"全部" }, { key:"finance", label:"财务" }, { key:"file-tool", label:"文件工具" }, { key:"user", label:"个人" }]`（key 类型 Category）。
    - 过滤：`const filtered = filterByCategory(filterSkills(skills, query), category);`（去掉旧的 `.filter(s => category === "all" || s.source === category)`）。import 补 `filterByCategory`（来自 `@/app/skills/file-tree`）。
    - 空态文案不变。

### 阶段 5 — 改名与换位

13. **`app/shared/app-nav.tsx`** L261/263：`href="/files"`→`href="/knowledge"`；`<span>资料</span>`→`<span>知识库</span>`。其余不动。
14. **`app/shared/resource-tabs.tsx`**：把知识库 `<Link href="/knowledge">知识库</Link>` 挪到前面、对话文件 `<Link href="/files">对话文件</Link>` 挪到后面，`｜` 仍在中间。`cls(active === "...")` 判断不变。
15. **`app/files/page.tsx`** L658：`title="资料预览"`→`title="文件预览"`。

e2e `pages.spec.ts` 导航断言应转绿。

## 4. 测试与验证方式

**环境事实（重要）**：
- `tests/all.test.ts`（即 `npm test`）**当前基线就是红的**——它在 L302 `import("./shortcuts.test.ts")` 处崩溃（`AssertionError: AC6 FAIL: 组合冲突 active:mod+f`），因为上一轮加的 `search-settings` 与 `find-in-chat` 都是 mod+f、旧碰撞 key 不区分 scope。本任务阶段 1 第 1 步的 shortcuts.test.ts 修复正是要修这个。修完 + 加完 search-skills 后，`tests/all.test.ts` 应整体转绿。
- 本 worktree 的 `workers/.venv` 是**软链到父 checkout** 的（主循环已建），让完整套件（含 python 薪税脚本用例）能跑。**它是本地便利，不要 `git add` / 提交 `workers/.venv`**（它未被 gitignore，注意别误纳入提交）。

TDD 快速迭代（纯 node，无需 venv）——先单独跑本任务直接相关的两个文件确认红→绿：
```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/practical-liskov-301d5e
node --import tsx tests/shortcuts.test.ts       # 阶段1/3 后应输出 "shortcuts: all 6 checks passed ✓"
node --import tsx tests/skills-category.test.ts # 阶段1/2 后应输出 "skills-category checks passed ✓"
```
全量回归与类型：
```bash
npx tsc --noEmit 2>&1 | grep -v "^tests/" | grep -v "^\.next/" | grep "error TS"   # 应为空
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/all.test.ts        # 应整体绿(exit 0),不再崩在 shortcuts
# e2e(先起 mock server)
rm -rf .claude/e2e-mock/appdata
FINANCE_AGENT_APP_DATA_DIR=.claude/e2e-mock/appdata FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_SECRET_BACKEND=file npx next dev -p 3997 &
# 端口起来后:
BASE_URL=http://127.0.0.1:3997 npx playwright test e2e/mock/pages.spec.ts e2e/mock/chat.spec.ts e2e/mock/knowledge.spec.ts --reporter=list
```

- TDD 顺序：阶段 1 先落地/修改三处测试（shortcuts 碰撞 key+count+新断言、新建 skills-category、e2e 导航文案），确认单独跑时是红的（skills-category 因 filterByCategory 未定义/SKILL.md 无 category 而红；shortcuts 因 search-skills 未注册红），再按阶段 2-5 实现到绿。
- 手动走查（preview，起服务后需重启以加载改动）：导航"知识库"→/knowledge、tab 顺序、/skills 的 Cmd+F 聚焦、财务/文件工具 chip 过滤。

## 5. 风险与开放问题

- `tests/all.test.ts` 注册新文件时，照抄它现有的 import + await 模式；若它是顺序 await 各 promise，新加的放在合适位置即可，别打乱既有顺序。
- `resolveShortcut` 里 `find-in-chat` 和 `search-skills` 都是 `mod+f`，靠 scope 区分：在 `/skills` 页 pathname 推出 scope="skills"，`find-in-chat`(scope chat) 被 scope-skip 跳过、`search-skills`(scope skills) 命中；反之在 `/chat`。务必确认 scope-skip 判断把 skills 也纳入"scope 不匹配就跳过"，否则 search-skills 可能在非 skills 页误触发。
- `/skills/[name]` 详情页 pathname 也 `startsWith("/skills")` → scope="skills"，详情页没有搜索框，`useShortcutEvent("search-skills")` 只挂在首页组件上，详情页按 mod+f 不会有监听者接（dispatch 出去无人处理，等于无操作）——可接受，不算 bug；若要更严谨可后续在详情页拦截，本期不做。
- 12 个 SKILL.md 是内置技能内容文件，改动仅加一行 frontmatter，不影响正文与 SDK 加载；`parseSkillMd` 对未知键本就忽略，加 category 键是纯增量、向后兼容。
- 导航"知识库"改指 `/knowledge` 后，若有其它地方假设点导航一定到 `/files`（如埋点/引导），需留意——已确认 `trackFeature("nav.knowledge")` 语义本就是 knowledge，一致。
