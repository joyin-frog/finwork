# Audit: settings-restructure

> 执行日期：2026-07-04
> 执行人：implementer (claude-sonnet-4-6)
> 对应 spec：docs/spec/spec-settings-restructure.md

## Files changed

| 文件 | 动作 |
|---|---|
| `app/config/tabs.ts` | 修改 |
| `app/config/page.tsx` | 修改 |
| `app/config/skill-center.tsx` | 修改（布局重排） |
| `app/config/general/general-settings.tsx` | 修改 |
| `app/config/personalization/personalization-settings.tsx` | 新增 |
| `app/config/shortcuts/shortcuts-settings.tsx` | 新增 |
| `app/config/model/model-settings.tsx` | 修改 |
| `app/config/about/about-settings.tsx` | 修改 |
| `app/config/understanding/understanding-settings.tsx` | 删除 |
| `app/config/skill-catalog.tsx` | 删除 |
| `app/shared/app-nav.tsx` | 修改 |
| `app/shared/app-shell.tsx` | 修改 |

---

## 每文件变更说明

### `app/config/tabs.ts`
- 移除了 `NoteIcon`（不再需要）的导入，新增 `PaintBoardIcon`（外观 tab 图标）和 `KeyboardIcon`（键盘快捷键 tab 图标）。
- `CONFIG_TABS` 从 5 项改为 6 项：general / appearance / personalization / model / shortcuts / about，去掉了原来的 skills / understanding。
- `LEGACY_CONFIG_TAB_REDIRECTS` 去掉 `appearance: "general"`（appearance 现在是真实 tab），新增 `understanding: "personalization"` 和 `profile: "personalization"`，保留 `memory: "personalization"` 和 `usage: "model"` 的更新目标。
- **与计划偏差**：无。

### `app/config/page.tsx`
- 在 `legacyTarget` 赋值之前插入特判：`if (params?.tab === "skills") redirect("/skills")`，确保旧 `/config?tab=skills` 深链跳转到 `/skills` 而不是静默 fallback。
- **与计划偏差**：无。

### `app/config/skill-center.tsx`
- 移除了 `<h1>设置</h1>` 顶部标题，关闭按钮改为 `absolute right-3 top-3 z-10` 绝对定位。
- 顶部功能条改为 `absolute top-0 left-0 right-0 h-8`，只放 `DragHandle` + `SidebarToggle`，不占布局流。
- 两栏 flex 容器加 `pt-8` 为顶部功能条留空间。
- `aside` 内部加入受控搜索框（state `query`），下方 tab 列表按 `t.label.includes(query.trim())` 过滤，空结果显示"未找到匹配项"。
- 右侧 `main` 顶部标题行去掉 `border-b`，改为 `pt-5 pb-4`。
- 新增 `appearance` / `personalization` / `shortcuts` 三个 tab 分支；删除 `skills` 和 `understanding` 分支；`model` / `about` / `general` 分支保留，`general` 分支去掉 `roleMode`/`onRoleModeChange` props 传递。
- Imports：删除 `UnderstandingSettings` / `SkillCatalog`，新增 `AppearanceSettings` / `PersonalizationSettings` / `ShortcutsSettings` / `Search01Icon`。
- **与计划偏差**：外层容器由 `flex flex-col` + 子 `flex flex-1` 改为直接在外层容器上使用 `relative`，两个绝对定位元素（关闭按钮、顶部功能条）+ 一个 `flex flex-1 min-h-0 pt-8` 子容器。这是对 spec 描述（"顶部保留一个极窄的功能条"）的等效实现，视觉结果相同，都能消除顶部大标题行打断分隔线的问题。

### `app/config/general/general-settings.tsx`
- 删除了「主题」`SettingsSection`（含 `THEMES` 常量、`useTheme` hook）和「回复风格」`SettingsSection`。
- Props 类型去掉 `roleMode`/`onRoleModeChange`。
- Imports 中去掉 `useTheme`（`next-themes`）和 `Button`（`@/components/ui/button`）。
- **与计划偏差**：无。

### `app/config/personalization/personalization-settings.tsx`（新增）
- 组合「回复风格」`SettingsSection`（从 general-settings 原样迁移）+ `ProfileSettings` + `MemorySettings`。
- Props：`roleMode: "daily" | "tech"` / `onRoleModeChange`。
- **与计划偏差**：无，与 spec 代码块完全一致。

### `app/config/shortcuts/shortcuts-settings.tsx`（新增）
- 从 `SHORTCUTS` 数据源按 `GROUPS` 分两组渲染快捷键表格，复用 `formatShortcut` + `useIsMac`，用 `Kbd` 组件展示按键。
- 零 props，无编辑/删除按钮（非目标）。
- **与计划偏差**：无，与 spec 代码块完全一致。

### `app/config/model/model-settings.tsx`
- 新增 `import { UsageSettings } from "@/app/config/usage/usage-settings"`。
- 在现有"模型连接" `SettingsSection` 之后追加"用量" `SettingsSection`，渲染 `<UsageSettings />`。
- **与计划偏差**：无。

### `app/config/about/about-settings.tsx`
- 删除"用量" `SettingsSection` 整块（3 行）及 `import { UsageSettings }` 语句。
- **与计划偏差**：无。

### `app/config/understanding/understanding-settings.tsx`（删除）
- 删除前确认 `grep -rn "UnderstandingSettings"` 在整个 `app/` 目录下只有自身定义，无其他引用方。
- **与计划偏差**：无。

### `app/config/skill-catalog.tsx`（删除）
- 删除前确认 `grep -rn "SkillCatalog\|skill-catalog"` 在整个 `app/` 目录下只有自身定义，无其他引用方（`skill-center.tsx` 已移除引用）。
- **与计划偏差**：无。

### `app/shared/app-nav.tsx`
- `NavActive` 联合类型加 `"skills"`。
- 导入列表加 `NoteIcon`。
- 在「资料」`<Link href="/files">` 后新增「技能」`<Link href="/skills">`，点击 `trackFeature("nav.skills")`，激活判断 `active === "skills"`。
- **与计划偏差**：无。

### `app/shared/app-shell.tsx`
- `active` 变量类型联合加 `"skills"`。
- 在 `/agents` 分支之后、`/config` 分支之前新增 `else if (pathname.startsWith("/skills")) { active = "skills"; }`。
- **与计划偏差**：无。

---

## 测试结果

```
npx tsc --noEmit
```

`app/` 和 `lib/` 范围内：**0 类型错误**（无新增错误）。

退出码 2 来自预先存在的错误（与本次改动无关）：
- `tests/` 目录：大量 `TS5097`（`.ts` 扩展名导入）和其他测试相关错误，均为原有问题。
- `.next/types/app/dev/message-scroller/page.ts`：`.next` 生成文件的模块缺失，原有问题。

验证命令：`npx tsc --noEmit 2>&1 | grep -v "^tests/" | grep -v "^\.next/" | grep "error TS"` → **空输出**（无匹配，即 app 范围 0 错误）。

---

## 开放风险

1. **顶部功能条可点击区域**：`DragHandle`/`SidebarToggle` 现在在 `h-8`（32px）的绝对定位条里，比原来 `h-11`（44px）窄。Mac 窗口拖拽区域和折叠按钮的可点击面积有所减小，需要在浏览器里用鼠标实际验证（视觉走查，非自动化范围）。

2. **`UsageSettings` 同时挂载**：`UsageSettings` 现在可以同时在 model tab 里挂载，`useUsage()` 内部是 fetch 请求，无全局单例副作用，风险低（已读 `usage-settings.tsx` 源码确认）。

3. **搜索框仅过滤 tab 标签**：只做 tab 标签子串过滤，不做设置内容全文检索，与截图里可搜索设置选项的期望存在差距，已在 spec 非目标里写明，如用户验收时觉得不够需要再开迭代。

4. **`understanding` 目录残留**：删除了 `understanding-settings.tsx` 后，`app/config/understanding/` 目录本身为空（如果目录结构有 index 文件则需确认），但目录本身不影响编译和运行。
