# 侧栏卡片化翻转 — 方案与落地记录

> 状态:**已落地**(分支 `ui/sidebar-card-flip`,未提交,待真机目检)。核心翻转 + 跟进 1b/2b/3b 见文末「五、落地记录」。
> 目标视觉:左侧栏做成**浮起的圆角卡片**,主内容退为**平铺底层**(红绿灯待在侧栏卡片的顶栏里)。

## 一、当前实现机制(改前)

整套布局集中在两个文件:

- `app/shared/app-shell.tsx` — 外层背板 + `<main>`
- `app/shared/app-nav.tsx` — 侧栏 `<motion.aside>`

「主区浮卡 + 侧栏底层」由**三要素叠加**而成:

1. **背板色 = 侧栏色**:外层 `<div className="flex h-screen overflow-hidden bg-sidebar">`,而 `<aside>` 也是 `bg-sidebar` → 侧栏与背板同色融为底层。
2. **主区独立表面**:`<main>` 用 `bg-background`,与背板异色而浮出。
3. **只朝左的抬升**:展开时 `<main>` 加 `ml-1 rounded-l-xl border-l border-border shadow-[var(--elevation-inset)]`;`--elevation-inset` 是 `-8px 0 ...`,**只向左投影**(其余三边贴窗口看不见),主卡像从侧栏背板上向左掀起。

## 二、翻转改法(把三要素归属对调)

### 改动 1 — `app/shared/app-shell.tsx`

- 外层背板:`bg-sidebar` → `bg-background`(底层换成主内容底色)。
- `<main>`:删除 `!collapsed` 那段卡片处理(`ml-1 rounded-l-xl border-l border-border shadow-[var(--elevation-inset)]`),只保留 `flex-1 min-w-0 overflow-auto bg-background` → 变回贴窗口的底层。
- 连带:`cn`、`useNavState` 导入与 `collapsed` 变量在本文件不再被使用,需一并删除,否则 lint 报未使用。

### 改动 2 — `app/shared/app-nav.tsx`(`<motion.aside>`)

```tsx
<motion.aside
  className={cn(
    "flex flex-col bg-sidebar overflow-hidden shrink-0",   // 去掉 h-full
    // 展开时做成浮起卡片:四周留 4px 缝 + 圆角 + 描边 + 1 档柔影;折叠(width→0)时全去掉,避免露出碎片。
    !collapsed && "m-1 rounded-xl border border-border shadow-[var(--elevation-1)]"
  )}
  animate={{ width: collapsed ? 0 : 240 }}
  transition={SPRING_DEFAULT}
>
```

要点:
- **去掉 `h-full`**:外层是 row flex(默认 `align-items: stretch`),`<aside>` 不写高度时会被拉满;加 `m-1` 后自动「满高减上下 8px」,从而四周留缝。保留 `h-full` 反而撑出 8px 被 `overflow-hidden` 裁掉。
- **`!collapsed` 门控**:折叠 width→0 时必须同步去掉 `m-1/border/rounded/shadow`,否则露出 8px 宽的描边碎片。
- **阴影换四向**:`--elevation-inset` 是为「只朝左」设计的,侧栏四周都浮,改用对称的 `--elevation-1`(设计体系里 elevation-1 即「卡片」档 `--card-lift`)。

### 相关 token(`app/globals.css`)

- 翻转后 `--elevation-inset` **无人引用**(孤儿,无害,可保留或后续清理)。
- 亮色 `--sidebar: oklch(0.96 0 224 / 0.1)`(白底上为浅冷灰卡面);暗色 `--sidebar: oklch(0.275 0 0.5)` 比 `--background: oklch(0.25 0 0)` 略亮 → 暗色下天然显「抬起」。

## 三、边界情况结论

### 1. 右侧预览卡 —— 不受影响

预览卡(对话页 `.preview-page-shell.is-docked`、资料/知识页 `.preview-card-frame`,见 `app/styles/preview.css`)是**自包含的一张卡**,浮起靠自己的 `margin: 8px 0 / border-radius / border-left / box-shadow: var(--elevation-2)`,浮在 **`<main>` 的 `bg-background`** 上(`.preview-sidebar { background: transparent }` 透出主底色)。

翻转**没动 main 的背景色**,只去掉了 main 自己的卡片外壳,故预览卡视觉不变;反而少一层「卡中卡」嵌套,更干净。

- 一致性待定:翻转后左侧栏 `elevation-1`、右侧预览卡 `elevation-2`,两张浮卡阴影深浅不一。要对齐就把侧栏也提到 `elevation-2`;但 `elevation-1` 才是「卡片」语义档。看取舍。

### 2. 收起侧栏后的红绿灯 —— 不受影响,现有代码已处理

- 红绿灯由 macOS 在固定窗口坐标 **`(12, 24)`** 绘制(`src-tauri/src/lib.rs` 的 `traffic_light_position`,仅 `#[cfg(target_os = "macos")]` + `title_bar_style(Overlay)` + `hidden_title`),**始终存在**,不随侧栏 DOM 变化。
- 让位逻辑在 `app/shared/sidebar-toggle.tsx`:
  - 展开态:折叠按钮在侧栏内,header 只放 `w-3` 占位。
  - 收起态(侧栏 width→0,header 顶到窗口左缘):macOS 下加 **`pl-[70px]`**,排成「🔴🟡🟢 → ☰折叠按钮 → 标题」一行;非 mac 走 `pl-2`(无红绿灯,不留 70px)。
- 与翻转无关:两种设计**收起态完全一致**(都 width→0、卡片样式随 `!collapsed` 消失),差异只在展开态。

### 3. Windows 渲染 —— 卡片不丑,差异来自窗口框且为旧问题

- `src-tauri/tauri.conf.json` 全局 `"decorations": false` → Windows 为**完全无边框窗**;`lib.rs` 仅 macOS 段重加红绿灯/overlay 标题栏;Web UI **无自绘的最小化/最大化/关闭按钮**(`window-controls.tsx` 只有拖拽区 `DragHandle`),也**无 CSS 按 `data-platform` 分平台**。
- 卡片是纯 CSS(`border-radius/box-shadow/border/background`),Windows 走 WebView2(Chromium)逐像素一致,**不会因平台变样**。
- 翻转不会让 Windows 更难看:新旧版都是「方角无边框窗里放圆角卡」,观感一档;新版方角由平铺底层 `bg-background` 占着,卡片缩在内圈留缝,反而不会出现「半圆角贴方角窗」的接缝。
- **不确定点**:以上为配置 + CSS 推断,**未在真机 Windows 构建验证**;若要确认需 `npm run tauri build` 出 Windows 包实看(无边框窗 + 无窗口按钮本身与本翻转无关)。

## 四、待定项

- **A/B 取舍(基本已澄清)**:红绿灯在 `(12,24)`,即使 `m-1`(4px 缝)也仍落在侧栏卡片内 → 可直接走 **A(四周留缝全圆角卡片)**,无需为红绿灯改成「左上贴边」的 B 方案。
- **可选打磨**:若想让红绿灯相对卡片保持原内边距,把 `traffic_light_position` 由 `(12, 24)` 微调到约 `(16, 28)`(+4/+4 抵消 4px 缝)。需重新构建原生包才可见。
- **阴影统一**:侧栏 `elevation-1` 是否提到 `elevation-2` 与右侧预览卡对齐。
- **真机 Windows 验证**:出包实看一次。

## 涉及文件速查

| 文件 | 作用 |
|---|---|
| `app/shared/app-shell.tsx` | 外层背板 + `<main>`(改动 1) |
| `app/shared/app-nav.tsx` | 侧栏 `<aside>`(改动 2) |
| `app/shared/sidebar-toggle.tsx` | 收起态为红绿灯让位(`pl-[70px]`) |
| `app/styles/preview.css` | 右侧预览卡 `.preview-page-shell.is-docked` / `.preview-card-frame` |
| `app/globals.css` | `--sidebar` / `--elevation-*` token |
| `src-tauri/src/lib.rs` | `traffic_light_position`、macOS overlay 标题栏 |
| `src-tauri/tauri.conf.json` | `decorations: false`(全局无边框) |

## 五、落地记录(分支 `ui/sidebar-card-flip`,未提交)

按二、三节落地,并随目检追加了 3 处跟进。lint 0 error、typecheck 通过;测试套件与改前一致(预存在 async teardown flaky 与本次无关)。

- **核心翻转**(改动 1 + 2):`app/shared/app-shell.tsx`(背板→`bg-background`、`<main>` 去卡壳、删 unused 导入)、`app/shared/app-nav.tsx`(`<aside>` 去 `h-full`、展开态加 `m-1 rounded-xl border shadow-[var(--elevation-1)]`)。
- **1b 去标题分隔线**:5 个主页面 `<header>`(`h-11`)去掉 `border-b border-border`——`chat-page.tsx` / `cockpit/page.tsx` / `files/page.tsx` / `knowledge/page.tsx` / `config/skill-center.tsx`。次级分隔线(无 `h-11`)不动。理由:该线是吸顶标题/内容分隔,与卡片无关、纯审美;翻转后整体更通透。
- **2b maximize 加回左边框**:`app/styles/preview.css` 两条 `.is-maximized` 规则(`.preview-page-shell.is-docked.is-maximized` / `.preview-card-frame.is-maximized`)`border-left: 0` → `1px solid var(--border)`,覆盖对话/资料/知识 3 处。圆角不加回(边到边铺满,圆角会在窗口边留怪缝)。理由:翻转后主区无边框,maximize 左侧失去原本由主卡提供的分隔线。
- **3b 横向滚动条常显**:`app/globals.css` 加 `::-webkit-scrollbar-thumb:horizontal` 默认可见色(+ hover 加深)。**竖向逻辑完全不动**(仍 `.fa-scrolling` 淡入淡出)。根因:横向有溢出且未被裁,但滚动条是 overlay——macOS 只显当前滚动轴、Windows WebView2 鼠标用户无 Shift 横滚习惯 → 横向溢出无法被发现。机制级,影响所有横向溢出容器,非 Excel 专属。
  - 诊断:`/e2e-preview` + 临时 Playwright 探针实测 `scrollWidth 800 / clientWidth 272`(确有溢出)、祖先 `clipsScrollbar` 全 false(未裁切)、`offsetHeight-clientHeight=0`(overlay)。探针已删。
  - **待真机确认**:headless Chromium 滚动条渲染 ≠ macOS WKWebView / Windows WebView2,最终以真 app 为准。

### 仍待办
- 真机(macOS + Windows 出包)目检:卡片观感、maximize 左边框、横向条常显。
- 侧栏阴影是否统一到 `elevation-2`(与右侧预览卡对齐)——未决。
- 可选 `traffic_light_position` 微调(+4/+4)——未做。
