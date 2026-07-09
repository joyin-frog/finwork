# Linear 打磨 R3：清理 + 横线/渐隐 + 风格改名默认 + 设置控件 + Excel 行列选中 Spec

> 版本 v1.1 / 2026-07-09（计划审查修订：Files touched 补全点3四文件[B1]、useState初值改linear[N1]、ToggleGroup spacing=0[N2]、radius token两风格差值[N3]、playground不动[N4]、Excel选区与focusCell互斥+用cell.columnIndex[N5/N6]）
> 状态：已批准
> 依赖：spec-linear-polish-r2、design-two-style-system 记忆、audit-style-abstraction.md、eval-color-themes.md
> 架构事实：
> - 双风格技术值 `data-style="default"`(经典)/`"linear"`(现代)，挂 <html>；明暗 next-themes .dark；风格覆盖在 globals.css 末尾挂载区。
> - `.app-page-header`（globals.css:289）= 七页统一标题栏底线（现 `border-bottom:1px solid var(--border)`）。各页 header className 主体 `relative flex items-center gap-3 pr-5 h-11 shrink-0`。
> - 风格默认链路：layout.tsx:55 SSR `data-style="default"`；layout.tsx head no-flash 脚本只认 "linear"；appearance-settings.tsx 读写 localStorage "app-style"。
> - 设置分组组件：settings-ui.tsx 的 `SettingsSection`（`section.flex.flex-col.gap-3`）；各设置页外层自定 gap（appearance gap-8、shortcuts **漏 gap**）。
> - 外观设置(appearance-settings.tsx)主题/风格是**手写 Button 组**；可复用 `components/ui/toggle-group.tsx`(Radix ToggleGroup)。
> - Excel 预览唯一在 file-preview-page.tsx:613-725（CSV 同结构）；列头 `th.preview-excel-column-header`(:637)、行号 `th.preview-excel-row-header`(:651)、数据格 `td.preview-excel-cell`(:670) 有 focusCell onClick；列头/行号**无 onClick**；有 activeCellPos 单元格级 is-active 基建，无整行/整列选中。

## 0. 目标与非目标
**目标**：9 点里的改动项。点4(token 问答)、点9(配色评估)已在对话/eval 文档交付，不在本 spec。
**非目标**：颜色主题功能不实现（点9 只评估）；不动 tone/chart/destructive；Excel 选中不做多选/框选（只做点列头选整列、点行号选整行、角格选全表）。

## 1. 成功标准
- [ ] 点1：audit 列的最后一公里清理——files/page.tsx text-amber-600→tone token；sidebar-toggle pl-[70px]→--tl-inset；preview.css border-radius:12px→radius token；text-white 评估后保留或 token 化（记录理由）。
- [ ] 点2：七页标题底线更淡 + 两端留缝（不顶到边）。一处可调。
- [ ] 点3：内容滚动接近标题底线时顶部渐隐（fade，非 blur）。主要内容页生效；不裁掉卡片阴影到不可接受。
- [ ] 点5：快捷键设置页分组间距与其他设置页一致（补 gap）。
- [ ] 点7：**现代(linear)成为默认风格**；设置里风格按钮改名"现代"/"经典"；新用户/清缓存首屏=现代；选经典持久化、刷新保持、无首帧闪烁。
- [ ] 点8：外观设置的主题、风格切换改用 ToggleGroup(type=single) 分段控件（替代手写 Button 组），视觉更统一。
- [ ] 点6：Excel/CSV 预览点列头选中整列、点行号选中整行、点角格选全表，高亮如 Office；再点空白/单元格取消。多处预览共用同一渲染故一处改全生效。
- [ ] lint + typecheck + `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 绿。

## 2. Files touched
批A(样式/设置)：app/globals.css、app/config/shortcuts/shortcuts-settings.tsx、app/layout.tsx、app/config/appearance/appearance-settings.tsx、app/files/page.tsx、app/shared/sidebar-toggle.tsx、app/styles/preview.css、**点3 内容页(4 个)**：app/cockpit/page.tsx、app/chat/chat-page.tsx、app/knowledge/page.tsx、app/agents/page.tsx（files/page.tsx 已在上列）——点3 是渐进增强，**允许部分页跳过，audit 记录跳过原因**。
批B(功能)：app/shared/file-preview-page.tsx、app/styles/preview.css。
audit：docs/spec/audit-linear-polish-r3-batchA.md、-batchB.md。

## 3. 实施步骤

### 批 A

**3.1（点1 清理）**
- files/page.tsx:649 `text-amber-600` → `text-[var(--tone-notice)]`（该处是"已保留"类的琥珀语义，与 KIND 用的 tone-notice 一致）。
- files/page.tsx:54-57 KIND_CHIP_SELECTED 的 `text-white`：这是 tone 实色底上的选中态白字，**不随品牌色**（tone 是功能色）。评估：四个 tone 实色 L 都 ≤0.57，白字 AA 通过 → **保留 text-white，加一行注释说明"tone 实底配白字，非 --primary，无需 token 化"**。若 implementer 实测某 tone 白字对比不足再议。
- sidebar-toggle.tsx:22 `pl-[70px]` → `pl-[var(--tl-inset)]`（80px 单一来源）。实测默认风格收起态红绿灯不压住按钮（80px 比 70 更宽，安全）。
- preview.css:429、444 的 `border-radius: 12px`（.preview-page-shell.is-docked 和 .preview-card-frame）→ `var(--radius-lg)`。**非零变化**：默认 --radius-lg=0.7rem≈11.2px（差 0.8px）；**现代(linear) --radius=0.625rem→--radius-lg=10px（差 2px，比默认明显）**。两风格都实测：若 linear 下 10px 与相邻 linear 圆角元素（主卡 --radius-xl=14px）不协调，可改用 `var(--radius-xl)`（linear 14px 与主卡一致、默认≈15.7px）——由 implementer 实测选 --radius-lg 还是 --radius-xl 更贴近原 12px 观感，记入 audit。

**3.2（点2 横线淡+留缝）** globals.css 的 `.app-page-header`（:289）改为伪元素画线以支持"两端留缝"（border-bottom 无法留缝）：
```css
.app-page-header { position: relative; }
.app-page-header::after {
  content: ""; position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0; height: 1px;
  background: color-mix(in srgb, var(--border), transparent 40%);  /* 比原更淡 */
  pointer-events: none;
}
```
删原 `border-bottom`。注意：各页 header 已带 `relative`（确认；若某页 header 无 relative 需补，但主体类含 relative）。**overflow 风险**：knowledge/files header 有 `overflow-x-auto`（隐含 overflow-y:auto 会裁 y 溢出）——::after 在 bottom:0 盒内不溢出，安全；但若被横向滚动裁需实测。留缝值 0.75rem 起步，实测可调。

**3.3（点3 内容渐隐）** globals.css base 层加 utility：
```css
/* 内容滚动区顶部渐隐:靠近上方标题栏时内容淡出(fade,非 blur)。挂在各页主内容滚动容器上。 */
.content-fade-top {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 20px);
  mask-image: linear-gradient(to bottom, transparent 0, #000 20px);
}
```
应用到主要内容页的**内容滚动容器**（header 之后那个 overflow-auto/y-auto 的元素）：cockpit(page.tsx:70 `flex-1 overflow-auto`)、chat、knowledge、agents、files 的列表滚动区。implementer 逐页找到滚动容器加类，**实测**：(a) 顶部内容滚动到标题下时确有渐隐；(b) 渐隐 20px 不把卡片顶部阴影/hover 外扩裁出明显缺口——若某页首行元素紧贴顶且阴影被裁难看，该页跳过并在 audit 记录。此点是渐进增强，允许部分页不挂。

**3.5（点5 快捷键间距）** shortcuts-settings.tsx:15 外层 `<div className="flex flex-col">` → `flex flex-col gap-8`（与 appearance-settings.tsx:42 一致）。

**3.7（点7 现代为默认 + 改名）**
- layout.tsx:55 SSR `data-style="default"` → `data-style="linear"`（默认现代）。
- layout.tsx no-flash 脚本改为：`try{var s=localStorage.getItem("app-style");if(s==="default")document.documentElement.dataset.style="default"}catch(e){}`（只有用户显式选过经典才切回；否则保持 SSR 的 linear=现代）。
- appearance-settings.tsx：
  - STYLES 改 `[{value:"linear",label:"现代"},{value:"default",label:"经典"}]`（现代在前）。
  - **useState 初始值也改为 `"linear"`**（现状 :23 是 `"default"`；不改会在设置页首帧闪一下"经典"选中再跳"现代"）。
  - mount 读取：`document.documentElement.dataset.style === "default" ? "default" : "linear"`（默认 linear）。
  - 选经典(default)→`localStorage.setItem("app-style","default")` + dataset=default；选现代(linear)→`localStorage.removeItem("app-style")`（回默认现代）+ dataset=linear。
- 技术值 default/linear **不改**（CSS 选择器 [data-style='linear'] 不动）；只是默认值反转 + label 改中文名。
- 调试台 theme-playground.tsx（:347/370）现状：linear→setAttribute、否则 removeAttribute。反转后**无需改**：removeAttribute 移除属性 → CSS 基础层就是经典（无 [data-style='linear'] 覆盖），调试台切"经典"仍正确。**不要动 playground**（避免多余改动）。

**3.8（点8 ToggleGroup）** appearance-settings.tsx 主题(THEMES)、风格(STYLES)两个按钮组改用 `components/ui/toggle-group.tsx` 的 `ToggleGroup type="single"` + `ToggleGroupItem`（先读组件确认 props）。**连体分段视觉必须传 `spacing={0}` + `variant="outline"`**（默认 spacing=2 是带间距的独立 toggle，非连体；spacing=0 才去 gap、连成一条分段控件）。value 绑当前 theme/style，onValueChange 调原 setTheme/handleStyleChange。**空值拦截**：single 模式点已选项会回调空串，`onValueChange` 里 `if(!v) return;` 保持原值（不可全空）。保持 label 文案。

### 批 B

**3.6（点6 Excel 行列选中）** file-preview-page.tsx Excel 渲染(:613-725)：
- 新增 selection state：`const [colSel, setColSel] = useState<number|null>(null)` `const [rowSel, setRowSel] = useState<number|null>(null)`（或合并成 `{type:'col'|'row'|'all'|null, index}`）。切 sheet 时重置。
- 列头 th(:637) 加 onClick 选整列（**index 用列头 map 的 index，需与数据格的 `cell.columnIndex` 对齐——先读 :637 列头循环用的是什么序号，保证列头 index 与 cell.columnIndex 同一套**）、`role="columnheader"`、cursor-pointer；角格 corner onClick 选全表（**corner th 的精确行 implementer 读 :624-637 thead 确认，spec 未给行号**）；行号 th(:651) 加 onClick 选整行（用 rowNumber）。三者点击时互相清空（点列清行/全、点行清列/全）。
- 高亮：数据格 td 依据 `colSel===cell.columnIndex || rowSel===rowNumber || allSel` 加 class（**必须用 `cell.columnIndex`（:673 的 data-column-index 就用它），不是外层 map 序号——合并单元格时两者不等**）；列头/行号选中时自身加更深 `is-header-sel`。
- **与 focusCell/activeCellPos 互斥**：点列头/行号/角格时同时 `setFocusCell(null)`，否则 activeCellPos 派生的单元格级 is-active 列头 与 新选中列头 会双高亮（Office=点列头即取消单元格焦点）。
- preview.css 新增选中态样式（仿 is-active 但更明确的"整列/整行"底色，用 --accent 或 tone-neutral wash；表头选中用更深）。Office 感：选中列头深色、该列数据格浅色 wash。
- 取消：点数据格（setFocusCell 已有）时清 col/row/all sel；点已选列头再点可取消（可选）。
- 无障碍：列头/行号 `aria-selected`。
- 实测：knowledge 页预览 xlsx、files 页预览 xlsx、对话文件预览 —— 同一 FilePreviewPage 组件，一处改全生效；点列头整列高亮、点行号整行高亮、点角格全表、切 sheet 重置。

## 4. 测试与验证
```bash
npm run lint
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```
preview_*（先清 documentElement 内联残留）：
- 点7 重点：清 localStorage app-style + 刷新 → 首屏应是**现代**（无闪一下经典）；设置里显示"现代"选中；选"经典"→刷新保持经典；再选现代→刷新保持现代。
- 点2/3：七页标题淡线+留缝；内容滚动顶部渐隐。
- 点8：主题/风格为分段控件，单选可用不可全空。
- 点6：Excel 预览点行列头选中高亮（截图）。
- 默认风格回归：点7 反转后"经典"风格本身仍与之前的默认风格一致（像素）；点1 的 radius token 化微差可忽略。

## 5. 风险
- 点7 是**默认风格反转**，影响所有新用户首屏——no-flash 逻辑反转要防闪烁，重点实测。技术值不变故 CSS/既有 linear 规则不受影响。
- 点3 mask 可能裁卡片阴影；渐进增强，允许部分页不挂并记录。
- 点1 radius token 化引入默认预览卡 ~0.8px 圆角微差（非纯零变化，已知接受）。
- 点8 ToggleGroup single 的"可取消到空"要拦。
- 点6 是新功能，selection 状态与既有 focusCell/activeCellPos 交互需理清，勿破坏公式栏。
