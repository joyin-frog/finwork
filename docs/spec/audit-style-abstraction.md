# 审计：风格抽象体检 — 多风格/多颜色扩展就绪度

审计日期：2026-07-09  
审计范围：`app/globals.css`（全文）、风格挂载区、各页 header、重复样式模式、颜色 token 就绪度

---

## 现状盘点

### token 分层（globals.css 层次结构）

| 层 | 选择器 | 内容 |
|---|---|---|
| 1. Tailwind 接口层 | `@theme inline` | 把 Tailwind 的 `--color-*` / `--spacing-*` / `--radius-*` 映射到 CSS 自定义属性；密度 spacing 工具类（`p-page` / `gap-section` / `gap-card`）也在这里 |
| 2. 字阶层 | `@theme` | `--text-figure` … `--text-caption`，带 line-height / font-weight / letter-spacing，生成 `text-*` 工具类 |
| 3. 根 token 层 | `:root` | 几何 token（`--nav-width` / `--tl-inset`）、密度 token（`--surface-pad` / `--page-pad` 等）、可调设计 token（`--background` / `--primary` 等）、派生 token（elevation / tone / chart / scrim / motion） |
| 4. 暗色层 | `.dark` | 覆盖 `:root` 中的可调 token 与派生 token（elevation 单独加深） |
| 5. 桥接层 | `:root`（第二块）| 旧名别名（`--text` / `--surface` 等）供 `preview.css` 消费；行距旋钮 `--lh-*` |
| 6. 语义类层 | 全局 | `.app-page-header`（底线）、`.icon-btn`（图标按钮尺寸）、`.fa-tone-*`（tone 系统）、`.shimmer` / `.fa-spark` / `.fa-pulse`（动效） |
| 7. 风格挂载区 | `[data-style='linear']` + `html.dark[data-style='linear']` | 仅机制块，默认风格零覆盖 |

### 已完成的抽象

**双风格机制**：`<html data-style="...">` + globals.css 末尾的挂载区。页面代码零分叉；调试台（`/dev/theme`）支持双风格预览并可导出覆盖块。`appearance-settings.tsx` 统一写 `localStorage("app-style")` + `dataset.style`，`layout.tsx` 内联脚本首帧消除闪烁。

**几何 token**：`--nav-width: 15rem` 与 `--tl-inset: 5rem` 在 `:root` 单一来源。Linear 标签条展开态的 `app-tabbar-lead` 宽度用 `var(--nav-width)` 对齐，标签左缘与主卡左缘通过共享 token 保证。JS 侧 `NAV_WIDTH_PX = 240` 是 Framer Motion 需要数值的**有记录的孪生**，注释明确"改任一须同步另一处"，不算违规。

**密度 token**：`--surface-pad` / `--page-pad` / `--section-gap` / `--card-gap` 四个旋钮。`[data-style='linear']` 覆盖一档收紧；`@theme inline` 生成 `p-page` / `gap-section` / `gap-card` 工具类；`[data-slot="card"]` 规则让 shadcn Card 也随密度 token 变化。

**`.app-page-header`**：统一底线（`1px + color-mix(border, foreground 8%)`），7 个页面统一挂载，Linear 风格下不需要额外覆盖。

**Surface 原语**：`components/ui/surface.tsx`，`cva(level × edge × shape × inset × pad)`，知识库、对话文件面板、状态标签等处已使用。

**Tone 系统**：`--tone-alarm` … `--tone-analysis` 14 个语义色 token。`.fa-tone-pill` / `.fa-toned` / `.fa-tone-dot` / `.fa-tone-edge` 工具类统一消费；dark 覆盖在 `.dark` 块集中处理。

---

## 可抽象项清单

### A. Header 主体重复（优先级：中）

**位置与重复程度**：6 个页面手写相同 header 结构：

| 文件 | 行号 | 差异 |
|---|---|---|
| `app/agents/page.tsx` | 178 | 基准版 |
| `app/cockpit/page.tsx` | 57 | 基准版 |
| `app/config/skill-center.tsx` | 96 | 基准版 |
| `app/skills/skills-manager.tsx` | 55 | 基准版 |
| `app/files/page.tsx` | 514 | 多 `min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`（窄列防换行）|
| `app/knowledge/page.tsx` | 816 | 同 files |
| `app/chat/chat-page.tsx` | 810 | `justify-between` 替代 `gap-3`（chat 特化） |

重复核心：`relative flex items-center gap-3 pr-5 h-11 shrink-0`（5 个属性）。

**抽象建议**：在 globals.css 追加语义类 `.app-page-header-body`，把这 5 个属性收进去（`.app-page-header` 本身继续只管底线）。files / knowledge 的滚动防换行变体作为 modifier 类或在调用处按需补。比组件方案轻，仍可组合。

**风险**：chat 的 `justify-between` 是语义差异（两端分布），需保持例外；files/knowledge 的滚动属性要明确是否也进基类。

---

### B. `inline-grid size-7 place-items-center rounded-md` 图标按钮（优先级：中）

**位置与重复程度**：7 处完全相同（base classes 全等，仅 active 态追加 `bg-accent text-foreground`）：

- `app/files/page.tsx` 523, 536
- `app/knowledge/page.tsx` 824, 836
- `app/skills/skills-manager.tsx` 64
- `app/config/skill-center.tsx` 105
- `app/cockpit/team-panel.tsx` 198

全量 class 串：`inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground`

**抽象建议**：扩展 `.icon-btn` 语义类（目前只管 32px 尺寸）加入 `display:inline-grid / place-items-center / border-radius:var(--radius-md) / color:var(--muted-foreground) / transition / hover 态`。或者新增 `.icon-btn-ghost` 类承接。调用处精简为 `className="icon-btn-ghost"` + 条件 `active` 类。

**风险**：`.icon-btn` 当前只管 width/height，扩展后影响所有消费方；建议先审 `nav-top-controls.tsx`（已用 `icon-btn`）确认视觉一致再合并。

---

### C. `p-1.5 rounded-md` ghost 小图标按钮（优先级：低）

**位置与重复程度**：9 处：

- `app/files/page.tsx` 483, 492, 551
- `app/knowledge/page.tsx` 698, 709, 753, 792, 848
- `app/agents/page.tsx` 210

全量 class 串：`p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors`

**抽象建议**：`.icon-btn-compact`（用 `padding: 0.375rem` 替代固定尺寸，图标由调用处决定大小）。

**风险**：preview.css 里 `.preview-empty-collapse-btn` 已为这类按钮加了 `position: absolute; top: 3px; right: 14px` 的空态定位，两个源头的 class 拆分须对齐。

---

### D. 分类 chip 基础样式（优先级：中）

**位置与重复程度**：3 处，base class 完全相同：

- `app/files/page.tsx` 572（`px-3 py-1 rounded-full border text-meta font-medium whitespace-nowrap cursor-pointer transition-colors`）
- `app/knowledge/page.tsx` 867, 881（相同串）

**抽象建议**：语义类 `.filter-chip`，覆盖 base。选中态（`bg-foreground text-background border-transparent` 或种类专色）仍由调用处按条件追加。若 --radius-chip（4px）与 rounded-full 的"胶囊"语义不同可维持 rounded-full 写法。

**风险**：files 的选中态按 kind 上种类专色（tone），knowledge 用 `bg-foreground text-background`，选中逻辑差异大，不建议把选中态也收进公共类。

---

### E. 资源卡 auto-fill 网格（优先级：低）

**位置与重复程度**：3 处：

- `app/files/page.tsx` 637
- `app/knowledge/page.tsx` 919
- `app/skills/skills-manager.tsx` 126

模式：`grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3`

**抽象建议**：`@utility resource-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(220px,1fr)); gap: var(--card-gap); }` 或抽为 CSS 语义类 `.resource-grid`（gap 走密度 token，避免直接写 `gap-3`）。

**风险**：skills 使用 `p-4` 外边距，files 使用 `px-3.5`，不影响网格本身。可以安全抽离。

---

### F. `preview-card-frame` / `preview-page-shell.is-docked` 圆角（优先级：中）

**位置**：`app/styles/preview.css` 第 429 行（`.preview-page-shell.is-docked { border-radius: 12px }`）和第 445 行（`.preview-card-frame { border-radius: 12px }`）。

**问题**：两处硬编码 `12px`，未走 radius token。Linear 风格用 `globals.css` 的 `border-radius: 0` 覆盖（已正确），但如果新增第三种风格也需要覆盖，需改两处 CSS。

**抽象建议**：改为 `var(--radius-xl)`（0.625rem × 1.4 ≈ 14px，当前默认风格 0.7rem × 1.4 = 0.98rem ≈ 16px，略大于 12px，可接受）；或新增 `--preview-card-radius: 12px` token，在 linear 覆盖块中设为 0。

**风险**：preview.css 是旧渲染器 legacy 文件，不宜大改；用新 CSS 变量最安全。

---

## 多颜色主题就绪度

### 当前状态

**切换品牌色最少改动**：4 处 `:root` + `.dark` 值：
1. `:root` 的 `--primary: oklch(0.546 0.215 262.9)` → 改 hue(262.9) 为目标色相
2. `:root` 的 `--primary-foreground: oklch(0.97 0 0)` → 暗色字（白色通常不变）
3. `.dark` 的 `--primary: oklch(0.62 0.19 262.9)` → 改 hue 同上
4. `.dark` 的 `--primary-foreground: oklch(0.915 0 0)` → 通常不变

调试台（`/dev/theme`）已有 oklch 分量滑块，技术路径可行。

**`oklch(from var(--primary) l c h / X%)`** 相对色语法在 globals.css 的 `btn-breathe` keyframe、`fa-pulse`、`fa-dot-pulse` 中正确使用，主色改 hue 后光环颜色自动跟随，无需改动。

**Tone/chart 独立性**：`--tone-alarm` … `--tone-analysis` 均使用固定 hue 值（27 / 48 / 85 / 150 / 248 等），与 primary（262.9）完全独立。切换品牌色不影响状态语义色，架构正确。

**Elevation 独立性**：elevation shadow 使用固定中性蓝 `oklch(0.16 0.018 253)` 作为阴影底色，不随品牌色变化，符合设计规范。

### 差距清单（距"一处改动换主题色"还差什么）

| 差距 | 文件:行 | 影响 | 改法建议 |
|---|---|---|---|
| `--primary` 无分量拆分 | `globals.css:130` | 改 primary 需改 4 处，且 oklch l/c 值分散在每处 | 在 `:root` 顶部加 `--brand-h: 262.9; --brand-c: 0.215;` 后令 `--primary: oklch(0.546 var(--brand-c) var(--brand-h))` —— 但目前 4 处手改已可接受 |
| `text-white` 硬编码 | `app/files/page.tsx:54-57` | 换深色品牌色时 white 文字可能对比度不足 | 改为 `text-primary-foreground` |
| `text-amber-600 dark:text-amber-500` | `app/files/page.tsx:649` | 书签"已保留"标记不走 tone 系统 | 改为 `text-[var(--tone-notice)]` 或 `style={{ color: "var(--tone-notice)" }}` |

### 建议的下版落地路径

1. **先修 2 个硬编码残留**（text-white / text-amber-600），清理后整个组件层无跨主题硬编码颜色。
2. **debug 台加"品牌色预设"**（蓝/紫/橙/绿），每个预设只存 `--brand-h` + `--brand-c` + `--primary-foreground-l`（对比度校准），导出时展开成完整 primary 值写入 globals.css。
3. **中期**：如果需要运行时切换（用户在设置里选），在 `appearance-settings.tsx` 里新增"主题色"选项，写入 `--primary` 自定义属性到 `document.documentElement.style`，与 `data-style` 机制平行，不互相干扰。

---

## 硬编码残留

| 残留 | 文件:行 | 当前值 | 应走的 token |
|---|---|---|---|
| macOS 红绿灯净空 `pl-[70px]` | `app/shared/sidebar-toggle.tsx:22` | 70px | `pl-[var(--tl-inset)]`（5rem = 80px）—— 注意：当前值与 token 不等（70 vs 80），需确认设计意图 |
| chip 选中文字色 `text-white` | `app/files/page.tsx:54-57` | 白色固定 | `text-primary-foreground` 或 `text-white`（若品牌色确保足够深） |
| 书签标记色 `text-amber-600 dark:text-amber-500` | `app/files/page.tsx:649` | amber 专名色 | `text-[var(--tone-notice)]` 或新建 `--tone-keep` token |
| 状态标签字号 `text-[10px]` | `app/knowledge/page.tsx:46` | 10px 魔数 | `text-caption`（`0.6875rem = 11px`，近似可用；或实际走 `.fa-tone-pill`，它已有 `font-size: 0.625rem = 10px` 硬编码待清理） |
| MetadataPanel 标签字号 `text-[10px]` | `app/knowledge/page.tsx:137,150` | 10px 魔数 | `text-caption` |
| 预览卡圆角 `border-radius: 12px` | `app/styles/preview.css:429,445` | 12px 魔数 | `var(--radius-xl)` 或新建 `--preview-card-radius` token |
| 错误边界内联样式（hex 颜色） | `app/global-error.tsx:39-113` | 全硬编码 | **故意**：error boundary 在 CSS 加载前渲染，无法引用 token，不需改 |
| `error.tsx` fallback hex | `app/error.tsx:50-110` | `var(--token, #hexfallback)` | 合理：有 CSS 变量主路径，hex 只作兜底，不影响主题系统 |

### `pl-[70px]` vs `--tl-inset` 差异说明

`--tl-inset: 5rem = 80px`，而 sidebar-toggle 使用 `pl-[70px]`。两者不等（差 10px），意味着 SidebarToggle 当前不是在复用几何 token，而是持有独立的魔数。如果设计意图是"让收起按钮比红绿灯区略靠左一点（70px 而非 80px）"，应新建 `--tl-sidebar-toggle-pad` 或在注释里说明差异原因。如果是无意偏差，应统一改为 `pl-[var(--tl-inset)]`。

---

## 不建议抽象的

### 1. 空状态 / 加载 / 错误区块

多页出现 `flex flex-col items-center justify-center py-16 text-body text-muted-foreground`，但：
- 每页内容不同（不同文字、不同按钮、不同操作）
- cockpit 与 agents 的错误态有"重试"按钮；knowledge 的预览空态有收起按钮
- 这是"巧合重复"——同一 CSS 布局模式用于语义上无关的场景。合并会导致 wrong abstraction（为让组件接受所有变体，要穿越大量 props）

### 2. knowledge 页的 `size-7 flex items-center justify-center border border-border rounded-md hover:border-primary hover:text-primary` 导航按钮

仅出现在 `app/knowledge/page.tsx` 的搜索结果导航（上/下一个匹配、"回搜索"、"在原文中查看"）。有描边、hover 变蓝的交互语义，与通用图标按钮的 hover-accent 语义不同。属于该页特定的"搜索导航按钮"样式，不应提升为全局类。

### 3. files 页的种类专色 chip（KIND_CHIP_UNSELECTED / KIND_CHIP_SELECTED）

每种 kind（upload / generated / knowledge / library）对应不同的 tone 变量。unselected 态使用 `oklch(from var(--tone-*) calc(l-0.12) c h)` 相对色算出暗化文字，与 `.fa-toned` 机制相同但用在边框变色 chip 上（不是状态徽章）。场景不同（分类过滤 vs 状态标记），不应合并进 `.fa-tone-pill`。

### 4. linear `.app-main` 的四边 margin 字面量

`margin: 0.25rem 0.375rem 0.375rem 0.5rem` 是 linear 风格浮起卡片的四边留缝值，单处出现，注释已说明每边意图。拆成四个 token 不带来复用价值（没有其他元素引用这些值），反而使 globals.css 增加无用 token。

### 5. 调试台（`/dev/theme`）内的硬编码

`theme-playground.tsx` 中 LIGHT / DARK 色表和字阶默认值是调试台的"工厂设置参考值"，不参与运行时样式。它们需要与 globals.css 保持对应，但这是文档性质的对应，不是运行时依赖，不在"抽象"范围内。
