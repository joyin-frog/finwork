# Audit: linear-polish-r2 Batch B

## Files changed

| 文件 | 改动 |
|---|---|
| `app/skills/skills-manager.tsx` | 新建 header（§3.4 + §3.2）；移除常驻搜索框；添加 PageSearchBar |
| `app/config/skill-center.tsx` | header `border-b border-border` → `app-page-header`（§3.2）；移除左侧搜索框；页头加搜索图标钮；PageSearchBar 接入（§3.4） |
| `app/cockpit/team-panel.tsx` | 「派活」文字 → BubbleChatAddIcon 图标钮（§3.5） |
| `app/chat/composer-tips.tsx` | COMPOSER_TIPS 替换为 spec §3.8 的 12 条新文案 |

---

## 每文件改动说明

### app/skills/skills-manager.tsx
- 移除 `useRef` import（`searchInputRef` 已删除）；新增 `PageSearchBar`、`DragHandle`、`SidebarToggle`、`ShortcutHint` imports。
- 移除 `searchInputRef` ref；新增 `searchOpen: boolean` state。
- `useShortcutEvent("search-skills")` 回调改为 `setSearchOpen(true)`（PageSearchBar 内部自己监听 mod+f，两者幂等无冲突）。
- 原 `<div className="... h-12 ...">` 顶栏替换为 `<header className="app-page-header relative flex items-center gap-3 pr-5 h-11 shrink-0">`，依次放 DragHandle、SidebarToggle、h1"技能"、ml-auto div（含搜索图标钮 + 新建按钮）。
- 搜索图标钮用 ShortcutHint label="搜索" combo="mod+f" 包裹，query 非空时 bg-accent 高亮；仿 knowledge:832 样式（`inline-grid size-7 place-items-center rounded-md`）。
- `PageSearchBar` 渲染在非创建态的列表顶部、chip 行上方；`onOpenChange` 关闭时 `setQuery("")` 清空过滤残留。
- 移除了原来冗余的 JSX `{/* eslint-disable-next-line */}` 注释（lint 报 unused，已清除）。

### app/config/skill-center.tsx
- 新增 `PageSearchBar`、`ShortcutHint` imports；`useRef` 保留（saveClaudeRef、claudeSaveTimerRef 仍需）。
- 移除 `searchInputRef` ref；新增 `searchOpen` state；`useShortcutEvent("search-settings")` 改 `setSearchOpen(true)`。
- Header className：`relative flex items-center gap-3 pr-5 h-11 shrink-0 border-b border-border` → 前缀追加 `app-page-header`（去掉 `border-b border-border`，统一由语义类提供底线）。
- 页头 h1 后追加 ml-auto div，放搜索图标钮（同 skills-manager 样式）。
- 移除左侧 aside 内的常驻搜索框 div（含 HugeiconsIcon + input，共 17 行）。
- `PageSearchBar` 放在 aside 顶部（nav 之前）；onOpenChange 关闭时清 query。
- 移除冗余 JSX eslint-disable 注释（同上）。

### app/cockpit/team-panel.tsx
- 新增 `import { HugeiconsIcon } from "@hugeicons/react"` 和 `import { BubbleChatAddIcon } from "@hugeicons/core-free-icons"`。
- 原 `<button className="... px-2 py-0.5 ...">派活</button>` 替换为图标钮：`className="shrink-0 inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"`，内含 `HugeiconsIcon icon={BubbleChatAddIcon} size={14}`。
- `title="派活"` 保留鼠标悬停提示；`aria-label={`让${item.name}派活`}` 保留含角色名的动态值（读屏器可区分不同行）。
- `onClick={handleDispatch}` 不变。

### app/chat/composer-tips.tsx
- COMPOSER_TIPS 12 条全部替换（保持 12 条数量，轮播逻辑不变）。
- Tip 1：`输入 / 唤起技能，输入 @ 引用文件`——`/` 和 `@` 均用 `<span className={KEY_CHAR}>` 包裹（保留 mono 样式）。
- 条目 2–12：纯文本，文案按 spec §3.8。
- KEY_CHAR 常量未改动。

---

## 与计划的偏差

无实质偏差。两处细节说明：

1. **双 eslint-disable 注释简化**：知识库页搜索按钮用 JSX 注释 + 无 inline 注释；本批实现后 lint 报 JSX 注释 unused（`no-restricted-syntax` 触发点在 className 值行而非 `<button>` 开行），已改为仅在 className 行前加 `// eslint-disable-next-line`，与现存 chip 按钮写法一致。
2. **skills-manager header 高度**：spec 指定 `h-11`（44px）；原代码用的是 `h-12`（48px）div，已统一为 h-11（与全站其他页面 header 一致）。

---

## 测试结果

```
npm run lint       → 0 errors, 144 warnings（比改前 146 少 2，因移除 2 个 unused eslint-disable 注释）
npm run typecheck  → 0 errors in app/ files（src-tauri/target/ 内 pre-existing 错误与本批无关）
npm test           → 9 pass, 0 fail (FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true)
```

---

## 开放风险

1. **点 8 文案终审**：spec 标注「汇报请用户终审」，12 条新文案仅为建议稿，内容确认权在用户。
2. **.app-page-header 底线暂不生效**：该语义类由批 A 的 globals.css 定义；批 B 先跑时类名存在但无底线样式，skills-manager 和 skill-center 的 header 视觉上与批 A 合并后才完整——非功能性风险，等批 A 合并即修复。
3. **PageSearchBar 在设置页渲染位置**：搜索条出现在左侧 aside 顶部（aside 内部），有可能在特别窄的布局下被 aside 截断。实测若有问题可改为整页顶部 border-b 行（不改 spec 宽度 w-52 的情况下影响不大）。
