# Linear 风格打磨 R2 + 跨页一致性 + 抽象收尾 Spec

> 版本 v1.1 / 2026-07-09（计划审查修订：技能页 header 补 DragHandle/SidebarToggle[B1]、§3.7误引改§3.4、底线色改 var(--border) 起步实测可调、点9路径直接给结论、派活 aria-label 保留角色名、tip KEY_CHAR 样式保留）
> 状态：已批准
> 依赖：spec-linear-style.md、spec-linear-tabbar.md、design-two-style-system 记忆（几何 token --nav-width/--tl-inset 已建；铁律：几何禁镜像常量，对齐靠结构）
> 架构事实（写给全新上下文）：
> - Tailwind v4 + Next App Router。设计 token 在 app/globals.css 的 :root/.dark；风格覆盖在文件末尾"风格挂载区"（`[data-style='linear']` / `html.dark[data-style='linear']`，暗色必须组合选择器压过 .dark；注释内禁止出现 CSS 注释结束序列）。无 layer 规则优先于 @layer utilities。
> - 双风格：default（零覆盖）/ linear。明暗由 next-themes（.dark class）。`data-nav-collapsed` 挂 <html>（app-shell.tsx effect 写入 useNavState().collapsed）。
> - 各页顶部 header 现状（scout 已确认）：cockpit `app/cockpit/page.tsx:57`、chat `app/chat/chat-page.tsx:810`、agents `app/agents/page.tsx:178`、knowledge `app/knowledge/page.tsx:816`、files `app/files/page.tsx:514`、config `app/config/skill-center.tsx:97`——className 主体都是 `relative flex items-center gap-3 pr-5 h-11 shrink-0`（knowledge/files 多 overflow-x-auto 等）。knowledge/files/config **已有** `border-b border-border`；cockpit/chat/agents **无**。skills 页(skills-manager.tsx)**无独立 header**。
> - 搜索复用范本：`app/shared/page-search-dialog.tsx` 导出 `PageSearchBar`，props `{open,onOpenChange,value,onValueChange,placeholder,label,onSubmit?}`，内置 mod+f + Esc，条件渲染的搜索条（非 modal），渲染在列表列内 border-b 行。知识库用法见 `app/knowledge/page.tsx:832`(图标) + `:893`(PageSearchBar)。
> - 快捷键单一数据源 `app/shared/shortcuts.ts` SHORTCUTS(14条)；设置页 shortcuts-settings.tsx 与帮助弹窗都读它，**无漂移**。

## 0. 目标与非目标

**目标**：修 Linear 风格遗留细节 + 拉齐跨页一致性 + 为多风格/多颜色做一轮样式抽象收尾。默认风格：除"各页 header 统一加底线"这一项是**有意的全局一致性变更**外，其余像素零变化。

**非目标**：
- 颜色主题切换功能（多套配色）——用户明确留待下个版本，本期不做；点 7 仅把 Linear 的主色覆盖去掉。
- 多标签页（标签条仍 V1 单标签）。
- 移动端适配。

## 1. 成功标准（逐条可验证）

- [ ] 点1：Linear 收起侧栏后，内容页 header 内不再出现展开侧栏按钮（`.app-sidebar-toggle` 在 linear 下 display:none）；仍可从标签条的收起/展开按钮展开。默认风格该按钮照旧。
- [ ] 点2：cockpit/chat/agents/knowledge/files/config/skills 七页 header 底线统一（同一 `.app-page-header` 语义类），线比现在更淡；粗细/深浅在一处可调。默认+Linear 都统一。
- [ ] 点3：knowledge/files 分类 chip 行不再有底线。
- [ ] 点4：技能页、设置页搜索改为右上角图标触发（点击或快捷键），复用 PageSearchBar；常驻输入框移除。
- [ ] 点5：总览智能体面板每个角色行的"派活"改为 BubbleChatAddIcon 图标按钮（title="派活"）；空状态两个引导按钮不动。
- [ ] 点6：设置 tab "键盘快捷键"→"快捷键"。
- [ ] 点7：切 Linear 主色回默认（不再薰衣草蓝）；背板灰、发丝线、暗色表面色系保留。
- [ ] 点8：新对话 TIPS 按 §3.8 新文案落地。
- [ ] 点9：Linear 下预览全屏占满主卡内容区（无 4px 缝/圆角）；覆盖所有用 ResizablePreviewPanel 的页 + 对话页预览全屏路径；默认风格不动。
- [ ] 点10：产出 docs/spec/audit-style-abstraction.md 抽象清单（见 §3.10）。
- [ ] lint + typecheck 绿；FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test 绿。

## 2. Files touched

| 文件 | 点 | 改什么 |
|---|---|---|
| app/globals.css | 1,2,7,9 | .app-sidebar-toggle 改 display:none；新增 .app-page-header 底线语义类；删 linear 主色覆盖；加 linear 预览全屏占满规则 |
| app/cockpit/page.tsx | 2 | header 加 `app-page-header` 类 |
| app/chat/chat-page.tsx | 2 | header 加 `app-page-header` 类 |
| app/agents/page.tsx | 2 | header 加 `app-page-header` 类 |
| app/knowledge/page.tsx | 2,3 | header 的 `border-b border-border`→`app-page-header`；分类行去 border-b |
| app/files/page.tsx | 2,3 | 同上 |
| app/config/skill-center.tsx | 2,4 | header 的 border-b→app-page-header；左侧搜索框改右上角图标+PageSearchBar |
| app/skills/skills-manager.tsx | 2,4 | 新增 header(app-page-header)+右上角搜索图标；常驻输入框改 PageSearchBar |
| app/config/tabs.ts | 6 | label 改"快捷键" |
| app/cockpit/team-panel.tsx | 5 | "派活"文字按钮→BubbleChatAddIcon 图标钮 |
| app/chat/composer-tips.tsx | 8 | 12 条 tips 替换 |
| docs/spec/audit-style-abstraction.md | 10 | 新增(抽象清单) |
| docs/spec/audit-linear-polish-r2.md | — | implementer 产出 |

## 3. 实施步骤（分两批，A=样式/结构，B=交互/内容；点10最后单独）

### 批 A — 样式与结构（globals.css + 各页 header className + tabs.ts）

**3.1（点1）** globals.css linear 挂载区，把现有 `[data-style='linear'] .app-sidebar-toggle { padding-left: 0.25rem; }` 改为：
```css
/* 收起侧栏后,展开入口在标签条(NavTopControls),内容页头的展开按钮多余,linear 下隐藏 */
[data-style='linear'] .app-sidebar-toggle { display: none; }
```

**3.2（点2）** globals.css base 区（非 linear 专属，`.icon-btn` 附近）新增：
```css
/* 页面标题栏统一底线:一处调粗细/深浅 */
.app-page-header { border-bottom: 1px solid var(--border); }
```
底线色用 `var(--border)` 起步（默认亮色 border=oklch(0.95 0 0)，比原 knowledge/files 的 border-border 一致，不会更重）。**implementer 实测**：若 cockpit/chat/agents 三页加上后底线在白底上"几乎看不见"达不到统一效果，用户要的是"细/淡但可见"——则微调为略深可见值（如 `color-mix(in srgb, var(--border), var(--foreground) 6%)`），亮暗都实测一眼能辨且不刺眼为准；最终值记入 audit。
然后：
- cockpit/chat/agents 三页 header className 追加 `app-page-header`（现无 border）。
- knowledge/files/config 三页 header className 里的 `border-b border-border` **替换为** `app-page-header`（避免双份底线；其余 overflow 等类保留）。
- skills 页在 §3.4 新建 header 时直接带 `app-page-header`。
默认风格影响评估：cockpit/chat/agents 从"无线"变"有淡线"——这是点2要求的有意统一，不算回归；knowledge/files/config 从 border-border 变 70% 淡线，视觉微调，一致化。

**3.6（点6）** app/config/tabs.ts：`label: "键盘快捷键"` → `label: "快捷键"`（key `shortcuts` 不动）。

**3.7-color（点7）** globals.css linear 块删除主色覆盖：
- 亮 `[data-style='linear']`：删 `--primary`、`--primary-foreground`、`--ring` 三行。
- 暗 `html.dark[data-style='linear']`：删 `--primary`、`--ring` 两行。
- **保留**：--shell-canvas(亮暗)、--border(亮=发丝线)、--radius、密度、--sidebar:transparent、暗色 --background/--card/--popover/--foreground/--muted-foreground/--input（中性表面色系）、--elevation-*、全部 .app-* 布局规则。
验证：切 linear 亮色，选中导航项/发送按钮主色应为默认蓝 oklch(0.546 0.215 262.9) 而非薰衣草紫；背板仍浅灰、卡仍发丝线描边。

**3.9（点9）** globals.css linear 挂载区新增（放预览相关，注意覆盖两条全屏路径）：
```css
/* Linear:预览全屏占满主卡内容区,去卡框的缝/圆角/描边/影(默认风格不动) */
[data-style='linear'] .preview-card-frame.is-maximized,
[data-style='linear'] .preview-page-shell.is-docked.is-maximized {
  margin: 0;
  border-radius: 0;
  border: none;
  box-shadow: none;
  height: 100%;
}
```
路径已确认（无需再核实）：`app/shared/file-preview-page.tsx:432` 的 shell 元素同时挂 `is-docked` 和 `is-maximized`（`preview-page-shell${docked?" is-docked":""}${isMaximized?" is-maximized":""}`），对话页与 knowledge/files/agents 全走它；resizable-preview-panel.tsx:89 的 `.preview-card-frame.is-maximized` 是另一条（列容器）路径。上面两条选择器已覆盖两条路径，无需补挂任何钩子。实测：knowledge/agents/files/chat 四处预览点全屏，预览区四边与主卡内缘贴合无缝。

### 批 B — 交互与内容

**3.4（点4）** 搜索改图标触发，两页各自复用 PageSearchBar：
- **技能页 skills-manager.tsx**：**新建 header**（技能页当前无 header，是本页功能缺口）。header 结构参照 knowledge page（`app/knowledge/page.tsx:816-819`），className = `app-page-header relative flex items-center gap-3 pr-5 h-11 shrink-0`，**依次包含**：`<DragHandle />`（窗口拖拽，必须——否则技能页无法拖动窗口）、`<SidebarToggle />`（默认风格收起态的展开入口，必须）、标题 `<h1 className="text-title font-semibold">技能</h1>`、`<div className="ml-auto flex items-center gap-2 shrink-0">` 内放搜索图标按钮（Search01Icon，`ShortcutHint label="搜索" combo="mod+f"` 包裹，className 仿 knowledge:832）。DragHandle/SidebarToggle 从 `@/app/shared/window-controls`、`@/app/shared/sidebar-toggle` import。原常驻输入框(:57-73)移除；`query` state 保留（PageSearchBar 的 value）；新增 `searchOpen` state；PageSearchBar 渲染在列表区顶部（仿 knowledge:893），placeholder"搜索技能"，label"技能"。原 `useShortcutEvent("search-skills")` 改为 `setSearchOpen(true)`。过滤逻辑 filterSkills(skills,query) 不动。
- **设置页 skill-center.tsx**：左侧菜单顶部搜索框(:106-123)移除（DragHandle/SidebarToggle 已在页头 :97 那行，别重复）；页头（"设置"标题那行）右侧加搜索图标按钮（同款）；新增 `searchOpen` state；PageSearchBar 渲染在左侧 tab 列表顶部，placeholder"搜索设置"，label"设置"；`query` 过滤 `filteredTabs` 逻辑不动；`useShortcutEvent("search-settings")` 改为 `setSearchOpen(true)`。
两页注意：PageSearchBar `open` 关闭时（Esc）清空 query 以免过滤残留（onOpenChange 里 setQuery("")）。

**3.5（点5）** app/cockpit/team-panel.tsx 的"派活"按钮(:191-199)：文字改为 `<HugeiconsIcon icon={BubbleChatAddIcon} size={14} />`，`title="派活"`，**aria-label 保留含角色名的动态值**（现状 `让${item.name}派活` 这类，别退化成静态"派活"，否则读屏器无法区分角色行）；尺寸改为图标钮（仿技能卡片 skill-card.tsx:39 的图标钮样式：size-7 place-items-center rounded-md hover:bg-accent 之类，与该行其它元素协调）。onClick(handleDispatch) 不动。import BubbleChatAddIcon from @hugeicons/core-free-icons。

**3.8（点8）** app/chat/composer-tips.tsx 的 COMPOSER_TIPS 替换为下列 12 条（口吻延续现状：短句、场景化；顺序=常用优先）：
```
1. 输入 / 唤起技能，输入 @ 引用文件
2. 复杂的活可以交给多个专员协作
3. 开「深度思考」啃复杂推理问题
4. 拖文件到窗口即可上传
5. 生成的文件点开就能预览
6. 对话里的文件可存进知识库
7. 发我利润表，帮你做经营分析
8. 报销单据发我，批量核对不漏项
9. 发薪前让我算工资和个税
10. 月末让我列结账核对清单
11. 报销、薪资可导成金蝶凭证草稿
12. 问我公司能享哪些税收优惠
```
（数量维持 12；如轮播/随机逻辑依赖固定条数，核实后保持。**tip 1 的 `/` 和 `@` 保留现状的 KEY_CHAR span 样式**——composer-tips.tsx:10 有 `KEY_CHAR`（`rounded bg-muted px-1 py-0.5 font-mono` 之类），新文案里这两个字符仍用该 span 包裹，不要纯文本化。其余条目纯文本。）

### 点10（最后，独立）
批 A/B ship 后，产出 `docs/spec/audit-style-abstraction.md`：审 globals.css token 结构 + 各页面，列"可抽象清单"，为多风格/多颜色适配铺路。至少覆盖：
- header 已抽象为 .app-page-header（本期完成）；还有哪些重复结构可抽象（如各页 header 的 flex/gap/padding 主体、预览卡框、chip 行、空状态块）。
- 颜色 token 是否已足够支撑"换一套主色/中性色 = 改一处"（为下版主题色功能评估：primary 及其衍生是否都走 token、有无硬编码色相；tone/chart 是否独立于主题）。
- Linear 风格覆盖块是否还有"镜像常量/魔数"残留（延续几何禁镜像常量铁律）。
- 产出应是**清单 + 优先级建议**，不在本次实施（除非某项零风险顺手）。

## 4. 测试与验证

```bash
npm run lint
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```
preview_*（勿 Bash 起 server；先清 documentElement 内联残留）：
- 默认风格：七页 header 都有淡底线；cockpit/chat/agents 是新增（确认只多了底线、无其它变化）；skills 页新 header 正常；team-panel"派活"变图标；tips 更新；快捷键 tab 名"快捷键"。
- Linear 亮/暗：主色为默认蓝非紫；收起侧栏后内容页头无展开按钮；分类行无底线；预览全屏四边贴合无缝；搜索图标点击/mod+f 弹出搜索条。

## 5. 风险与开放问题
- 点2 默认风格三页新增底线是**有意变更**，reviewer 勿当回归。
- 点4 设置页搜索从"左菜单常驻"改"右上角触发"，交互位置变化；PageSearchBar 渲染位置(左列顶 vs 页头下)需实测不遮挡 tab 列表。
- 点9 路径已确认（file-preview-page.tsx:432 同挂 is-docked+is-maximized），无需补钩子。
- 点4 设置页/技能页把 `useShortcutEvent("search-*")` 改 `setSearchOpen(true)` 后，PageSearchBar 内部也监听 mod+f——两者幂等叠加无 bug，但可评估是否移除外层 useShortcutEvent 注册避免冗余（非阻塞，implementer 自行判断）。
- 点8 文案为建议稿，汇报请用户终审。
- 快捷键(点6)核对无漂移，若用户指"缺某功能快捷键"是新增需求，不在本期。
