# Windows 窗口控制区与应用外壳融合 Spec

> 版本：v1.1 / 2026-07-18（v1.1：合入现状审查结论，补随行清理/修复、min-h-0 与堆叠上下文防线、点击区贴边规则）
> 状态：已实施（2026-07-18；mac 开发态与 `?winchrome=1` 双风格已验证，§7.2 的 Windows 打包冒烟与 Alt-Tab 标题待真机）
> 基线提交：`aacd87e`（main 已含 9d67a8d UI 一致性改动与本 Spec 首版）
> 影响范围：桌面应用外壳；不恢复应用级顶部标签栏

## 1. 背景

Windows 目前使用无边框窗口，并在 Web UI 顶部渲染一条独立的 32px `WindowTitleBar`。该标题栏位于侧栏和主内容横排之前，因此三枚窗口按钮虽然只占右上角，却会把侧栏与主内容整体向下推，造成整条顶部空白。

macOS 当前由 Tauri 使用系统红绿灯、Overlay 标题栏和固定位置 `(12, 24)`；侧栏顶部已为红绿灯留出安全区，现有观感和拖动体验符合预期。

本次只优化 Windows 的壳层排布：让侧栏顶到窗口顶部，同时把 Windows 窗口控制区收进右侧主工作区。经典和现代风格共享同一套窗口几何，风格只决定表面、边距、圆角和阴影。

## 2. 目标

- Windows 经典风格下，侧栏不再被独立标题栏压低，展开态顶部回到窗口上缘（仍保留经典风格既有的 4px 卡片外边距）。
- Windows 现代风格下，复用原顶部标签栏所在的外壳位置承载拖动区和三枚窗口按钮，但不恢复标签内容。
- Windows 经典和现代统一使用 40px 窗口控制高度。
- Windows 侧栏顶部控制区同步为 40px，使左右两列顶部**高度一致**。注意：经典风格侧栏卡保留 `m-1`，故侧栏顶栏实际纵跨 4–44px、标题栏纵跨 0–40px——两列存在 4px 视觉错位且分隔线不共线，属预期接受项，不得为追求像素共线引入镜像常量或去掉卡片外边距。
- macOS 的红绿灯位置、侧栏顶部高度、拖动体验和主内容几何保持不变。
- 保留 Windows 最小化、最大化/还原、关闭、拖动窗口和双击拖动区切换最大化状态的能力。
- 侧栏展开、收起和拖动宽度时，窗口控制区不依赖镜像宽度计算，自然随主工作区伸缩。

## 3. 非目标

- 不恢复 `AppTabBar`、页面标签或会话标签。
- 不修改 macOS `TitleBarStyle::Overlay`、`traffic_light_position` 或系统红绿灯。
- 不修改 Windows `decorations(false)`、窗口尺寸、最小尺寸或边缘缩放策略。
- 不把窗口按钮覆盖到各业务页面自己的标题栏上；避免与搜索、分享、预览等页面级按钮发生碰撞。
- 不调整应用主题颜色；本任务只使用现有语义颜色 Token。
- 不顺手统一各页面标题栏结构。

## 4. 设计决策

### 4.1 外壳结构

把 `WindowTitleBar` 从全窗口纵向前置项移入主工作区列：

```text
AppShell（横排）
├── AppNav（侧栏，直接从窗口顶部开始）
└── app-workspace（主工作区纵排）
    ├── WindowTitleBar（仅 Windows/Tauri 或开发预览渲染）
    └── main.app-main
```

macOS、Linux 和 Web 下 `WindowTitleBar` 仍返回 `null`。`app-workspace` 只是几何中性的 `flex-1 min-w-0 min-h-0 flex-col` 包装层；不得增加 margin、padding、transform 或新的滚动容器，因此这些平台的侧栏和主内容位置不变。

两条容易踩的结构性硬约束：

1. **`main.app-main` 必须补 `min-h-0`**。它从横排子项（交叉轴 stretch，天然受限于视口高）变为 `app-workspace` 纵排的主轴子项；flex 子项主轴默认 `min-height:auto`，不补 `min-h-0` 时长内容会把 `main` 撑出视口、`overflow-auto` 失效，全站页面滚动坏掉。
2. **`app-workspace` 不得形成堆叠上下文**。`.app-titlebar` 的 `z-[60]` 依赖它与全屏模态（`fixed inset-0 z-50`，如设置页）同处根堆叠上下文才能压在模态之上、保证任何时候可最小化/关窗。包装层禁用的不只 `transform`，还包括 `filter`、`backdrop-filter`、`isolation:isolate`、`contain:layout/paint`、`perspective`、非 auto 的 `z-index` 等一切会创建堆叠上下文的属性。标题栏移入工作区后宽度不再横贯全窗，模态盖住侧栏顶部区域属预期（那里只是拖动区，无按钮）。

不采用“固定定位三件套覆盖业务页面”的方案。现有页面标题栏结构并不完全统一，覆盖方案需要给大量页面分别增加右侧安全区，容易再次出现嵌套预览列被错误推开的回归。

### 4.2 统一几何

新增单一几何 Token：

```css
--window-chrome-height: 2.5rem; /* 40px，仅 Windows 窗口壳层消费 */
```

Windows 两种风格均消费该 Token：

- `.app-titlebar` 高度为 40px。
- `.app-nav-topbar` 在 `data-platform="windows"` 下高度为 40px。
- macOS 不覆盖 `.app-nav-topbar`，继续使用现有 `h-11`（44px）。
- 经典与现代不得分别维护 32px/44px 常量。

40px 是窗口系统几何，不属于界面风格。经典与现代的差异只体现在：

| 项目 | 经典 | 现代 |
|---|---|---|
| 标题栏表面 | `--background` | `--sidebar`，与外壳连续 |
| 主内容 | 既有经典结构 | 保留现代主卡边距、圆角、描边和阴影 |
| 标题栏底部分隔 | 保留细分隔线 | 可由主卡上边界完成分层，不增加第二条重线 |

实施注意：分隔线目前以 `border-b border-border` **硬编码在组件 className**（`window-controls.tsx`）里，现代风格下也会渲染——这正是「第二条重线」的现状来源。必须把分隔策略下放到 CSS 风格映射（经典保留、现代置 `border-bottom: none` 或等效），组件里不再写死。

### 4.3 Windows 三枚按钮

功能调用保持不变：

- 最小化：`getCurrentWindow().minimize()`
- 最大化/还原：`getCurrentWindow().toggleMaximize()`
- 关闭：`getCurrentWindow().close()`

只调整视觉和点击几何：

- 每个按钮点击区域为 44px × 40px。
- 最小化、最大化、关闭图标统一为 14px。
- 还原图标因双框视觉重量更大，使用 13px。
- 点击区域不得随图标缩小。
- **关闭按钮点击区必须触达窗口右上角**：去掉现有 `pr-1` 尾部留白（或让关闭按钮点击区延伸到右缘），使最大化态下把鼠标甩到屏幕右上角像素即可命中关闭（Fitts 定律，Windows 原生标题栏惯例）。按钮间 `gap-0.5` 可保留，但不得在关闭按钮右侧留下不可点击的空隙。
- 关闭按钮仅在 hover/focus-visible 时使用现有 destructive 语义色；其他状态继续使用普通前景色。
- 保留当前最大化状态监听，窗口缩放后继续切换“最大化/还原”图标。现有实现（`isMaximized()` 初值 + `onResized` 订阅）经核实工作正常，权限由 `core:default` 覆盖，无需扩权。

### 4.4 拖动和双击

- `.app-titlebar` 保留 `data-tauri-drag-region`，其空白区域可拖动。
- `.app-nav-topbar` 继续通过 `DragHandle` 成为第二个拖动区，使用户可从侧栏顶部拖动窗口。
- 不新增手写 `onDoubleClick`；Tauri 已对拖动区提供双击切换最大化行为，重复绑定可能造成一次双击触发两次切换。
- 三枚按钮必须保持为拖动区内的独立交互目标，点击按钮不得触发窗口拖动。
- 保留 `core:window:allow-start-dragging`、`allow-minimize`、`allow-toggle-maximize`、`allow-close` 权限，不修改 capability 范围。

### 4.5 平台与风格矩阵

| 平台 | 经典 | 现代 |
|---|---|---|
| macOS | 零视觉、零行为变化；系统红绿灯在左 | 零视觉、零行为变化；系统红绿灯在左 |
| Windows | 侧栏提升；右侧主工作区顶部显示40px三件套 | 侧栏提升；原标签栏外壳位置显示40px三件套 |
| Linux | 保持原生窗口框；不渲染 Web 三件套 | 同经典 |
| Web | 不渲染 Web 三件套 | 同经典 |
| `?winchrome=1` | 视觉预览 Windows 经典结构，按钮不调用窗口 API | 视觉预览 Windows 现代结构，按钮不调用窗口 API |

收起侧栏时（两种风格、两个平台）：侧栏列宽度归零且 `pointer-events-none`/`inert`，其内的 `DragHandle` 失效；Windows 下顶部拖动完全由工作区标题栏承担，此时它恰好横贯全窗宽——该状态必须进验收。macOS 收起态沿用现状：页面头部的 `DragHandle` + `SidebarToggle` 的 `--tl-inset` 净空，不受本次改动影响。

### 4.6 随行清理与随行修复

1. **删除僵尸 Token `--window-controls-inset`**（`globals.css` 两处：`:root` 声明 0.5rem 与 `data-platform="windows"` 覆盖 6.75rem）。其唯一消费者 `.app-tabbar` 已随 `9d67a8d` 删除标签栏而消失，经全库 grep 核实现无任何引用。保留会与新 Token `--window-chrome-height` 并存造成误导。
2. **修复空窗口原生标题**（`src-tauri/src/lib.rs` 建窗链 `.title("")` → `.title("Finwork")`）。现状：Windows 无边框窗虽不显示标题文本，但 Alt-Tab、任务栏悬停提示均取原生窗口标题，当前为空白；macOS 因 `hidden_title(true)` 标题栏无感，但 Mission Control / Dock 窗口列表同样空白。`tauri.conf.json` 中 `app.windows[0].title: "Finwork"` 因该条目 `create: false` 且窗口由代码程序化创建而**从未生效**。此修复一行、跨平台无视觉副作用（macOS 标题仍被 `hidden_title` 隐藏）。这是 §5「除非测试暴露真实缺口不改 lib.rs」的已确认缺口，随本任务一并修，Windows 打包冒烟时验证 Alt-Tab 显示「Finwork」。

## 5. 预计改动文件

| 文件 | 改动 |
|---|---|
| `app/shared/app-shell.tsx` | 外壳改为横排；新增几何中性的 `.app-workspace`；把 `WindowTitleBar` 移入主工作区并置于 `main` 之前；`main` 补 `min-h-0`（§4.1 硬约束） |
| `app/shared/window-controls.tsx` | 标题栏高度改走 Token；调整按钮点击区和图标尺寸；关闭按钮点击区贴右缘（§4.3）；`border-b` 硬编码移出组件（§4.2）；更新注释；功能调用与平台判断不变 |
| `app/globals.css` | 新增 `--window-chrome-height`；Windows 侧栏顶栏同步高度；经典/现代只做表面和分隔策略映射；删除僵尸 Token `--window-controls-inset`（§4.6） |
| `src-tauri/src/lib.rs` | 仅一行：`.title("")` → `.title("Finwork")`（§4.6 随行修复，已确认的真实缺口） |
| `tests/window-chrome-layout.test.ts` | 新增壳层顺序、统一高度、macOS 不变和双风格无分叉的源码契约 |
| `tests/window-controls.test.ts` | 三键接线、最大化状态同步与点击几何的源码契约。仓库无 jsdom/testing-library，无法可靠挂载依赖 Tauri 运行时的客户端组件——按本行原兜底条款落为 `.ts` 源码契约（原因记录在测试文件头注释），真实功能以 Windows 打包冒烟收口 |
| `tests/all.test.ts` | 注册新增测试 |
| `docs/ui-conventions.md` | 记录“平台窗口系统几何独立于界面风格”的约束 |

除 §4.6 列明的一行标题修复外，不修改 `src-tauri/src/lib.rs` 其余部分，不修改 `src-tauri/tauri.conf.json` 或 capability 配置（capability 已核实：`http://127.0.0.1:*` 通配覆盖动态端口，三键与拖动权限齐全，见 §10）。

## 6. TDD 实施顺序

1. 写 `window-chrome-layout` 红测试，锁定：`AppNav` 与 `.app-workspace` 同级，`WindowTitleBar` 位于工作区内且在 `main` 前。
2. 写统一高度红测试，禁止经典/现代分别出现标题栏高度常量；Windows `.app-nav-topbar` 与 `.app-titlebar` 必须消费同一 Token。
3. 最小调整 `AppShell` 结构使测试转绿，先不改按钮视觉。
4. 在 `?winchrome=1` 下验证经典/现代、侧栏展开/收起和拖宽；修复布局回归。重点回归 §4.1 两条硬约束：长页滚动、模态下三键可点。
5. 写窗口按钮行为测试，再调整点击区和图标尺寸（含关闭按钮贴右缘）；功能调用必须保持绿。
6. 随行清理与修复（§4.6）：删除 `--window-controls-inset` 并全库确认无引用；`lib.rs` 标题一行修复。
7. 在 macOS Tauri 开发态对比基线，确认两种风格的红绿灯、拖动、双击和内容几何无变化。
8. 在 Windows 打包态完成最终窗口功能冒烟（含 Alt-Tab 标题）；未完成真实 Windows 验证时不得宣称功能已完全验证。

## 7. 验收标准

### 7.1 视觉与布局

- [ ] Windows 经典：侧栏顶部不再出现由全宽标题栏造成的空白；侧栏经典卡片仍保留既有 4px 外边距（接受 §2 所述 4px 顶部错位）。
- [ ] Windows 现代：侧栏、窗口控制区和窗口外壳连续使用 `--sidebar`；主卡位置、圆角和边距无回归；标题栏下**无**独立分隔线（分层由主卡上边界完成）。
- [ ] Windows 两种风格的窗口控制区和侧栏顶部高度均为40px，切换风格时三件套不跳动。
- [ ] 三个按钮点击区为44px × 40px，图标视觉尺寸符合 §4.3；关闭按钮点击区触达窗口右缘。
- [ ] 侧栏展开、收起和拖宽后，三件套始终贴主工作区右端，不出现基于旧侧栏宽度的空洞。
- [ ] 全站任一长内容页在新结构下滚动正常（`main` 的 `min-h-0` 生效，无整窗溢出）。
- [ ] 设置等全屏模态打开时，三件套仍可见可点（`z-[60]` 未被包装层堆叠上下文吞掉）。
- [ ] `--window-controls-inset` 已从 `globals.css` 全部移除，全库无引用。
- [ ] macOS 经典/现代与基线截图一致，红绿灯仍在左侧既有位置。

### 7.2 窗口行为

- [ ] Windows 最小化按钮有效。
- [ ] Windows 最大化按钮有效，最大化后图标切为还原；还原后切回最大化。
- [ ] Windows 关闭按钮有效；最大化态下鼠标甩到屏幕右上角像素点击可命中关闭。
- [ ] Windows 可从主工作区标题栏空白处拖动。
- [ ] Windows 可从侧栏顶部空白处拖动。
- [ ] Windows 收起侧栏后，标题栏横贯全窗宽，左上区域仍可拖动（侧栏 `DragHandle` 已随 `inert` 失效，全靠标题栏承接）。
- [ ] 双击上述两个拖动区均可最大化/还原，且一次双击只切换一次。
- [ ] 按下三枚按钮不会启动窗口拖动。
- [ ] Windows Alt-Tab 与任务栏悬停显示「Finwork」（§4.6 标题修复）。
- [ ] macOS 原有侧栏拖动区、系统红绿灯和双击行为不变。

### 7.3 自动化门禁

```bash
npm run lint
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npm run build
git diff --check
```

生产构建需使用隔离 `.next` 目录，避免与正在运行的本地开发服务器竞争。

桌面验证至少覆盖：

1. macOS：经典/现代 × 侧栏展开/收起；拖动与双击。
2. Windows `?winchrome=1`：经典/现代 × 亮/暗 × 侧栏展开/收起/拖宽。
3. Windows 打包应用：最小化、最大化、还原、关闭、主标题栏拖动、侧栏拖动、两处双击。

## 8. 风险与防线

- **全站滚动坏死（最高优先）**：`main` 从横排子项变纵排主轴子项后若漏补 `min-h-0`，长内容页整窗溢出、`overflow-auto` 失效。以「任一长内容页滚动正常」为验收硬门禁（§7.1）。
- **模态盖住三件套**：包装层若形成堆叠上下文（`transform`/`filter`/`backdrop-filter`/`isolation`/`contain`/`perspective`/非 auto `z-index` 任一），`.app-titlebar` 的 `z-[60]` 即与全屏模态的 `z-50` 不再同层比较，用户在模态下无法最小化/关窗。包装层保持零样式属性，验收含「模态打开时三键可点」（§7.1）。
- **macOS 几何回归**：新增工作区包装层若意外形成滚动容器，会改变现有体验。包装层禁止 `overflow-auto`、margin 和 padding，并以 macOS 前后截图为门禁。
- **收起态拖动真空**：收起侧栏后左上拖动完全依赖标题栏自动占满全宽；若实现改用固定宽度或绝对定位则会出现不可拖区域。验收含收起态拖动检查（§7.2）。
- **页面右上角碰撞**：窗口控制区保持独立工作区行，不覆盖业务页面标题栏，从结构上消除碰撞。
- **双击重复触发**：不同时使用 Tauri 拖动区内建切换和 React `onDoubleClick`。
- **按钮与拖动冲突**：行为测试必须确认按钮点击只调用对应 Window API。
- **现代双分隔线**：现代标题栏不额外叠加强分隔；以主卡上边界完成层次。分隔线必须从组件 className 移到 CSS 风格映射（§4.2），否则现代风格必然带线。
- **开发预览假绿**：`?winchrome=1` 只能验证几何和视觉，不能替代真实 Windows Tauri 功能测试。预览模式会强制 `data-platform="windows"`（`useDetectPlatform`），故新的平台高度规则在预览下同样生效，可用于布局验证。

## 9. 历史 Spec 关系

- `spec-linear-tabbar.md` 与 `spec-JOY-10-conversation-tabs.md` 中关于“Windows 标题栏位于标签栏之上、横贯全宽”的结构描述已过时；历史实现记录保留，但本 Spec 在窗口壳层排布上具有更高优先级。
- `--window-controls-inset` 是已删标签栏的遗产 Token，本 Spec 负责清理（§4.6）。
- 应用级顶部标签栏已删除，本任务不得以窗口适配为由恢复。

## 10. 现状审查结论（2026-07-18，基于 `aacd87e` 代码审查 + 浏览器实测）

实施前对 mac 红绿灯与 Windows 三件套现状做过一轮专项排查，结论如下，实施时不必重复验证：

**核实无问题（不要动）：**

- capability（`src-tauri/capabilities/default.json`）`remote.urls` 已含 `http://localhost:*` 与 `http://127.0.0.1:*` 通配——生产态动态端口探测（39211 起顺延，`resolve_server_port`）不会让三键/拖动因 origin 不匹配失效。`core:window:allow-minimize/toggle-maximize/close/start-dragging` 齐全，`isMaximized`/`onResized` 由 `core:default` 覆盖。
- `WindowTitleBar` 最大化态图标同步（`isMaximized()` 初值 + `onResized` 订阅 + unlisten 清理）逻辑正确。
- `useWinChromePreview` 双护栏（非生产构建 && 非真 Tauri）正确，打包端不受 `?winchrome=1` 影响。
- `.app-titlebar` `z-[60]` 压 `fixed inset-0 z-50` 全屏模态成立（当前根堆叠上下文下实测）。
- Windows 侧栏顶栏靠左规则（`data-platform="windows"` → `flex-start` + 0.5rem）与 `SidebarToggle` 的 `--tl-inset` 间接（Windows 覆写为 0.5rem）协同正确，真 Windows 与 mac 开发预览表现一致。

**已确认缺陷（并入本 Spec §4.6）：**

- 原生窗口标题为空（`.title("")`；conf 里的 `title: "Finwork"` 因 `create:false` 不生效）→ Windows Alt-Tab/任务栏悬停空白。
- `--window-controls-inset` 僵尸 Token。
- 现代风格标题栏 `border-b` 硬编码（§4.2 实施注意）。

**已知但明确不在本次范围（挂账）：**

- macOS 红绿灯纵向对位：`traffic_light_position(12, 24)` 使灯心约在 y≈31px；经典侧栏顶栏（4–48px）控件中线 26px、现代（0–44px）中线 22px，存在 5–9px 的理论偏低。`audit-linear-tabbar.md` 早已挂「实机 ±4px 微调」待办。本 Spec 承诺 macOS 零变化，该项仍留待单独的 mac 实机校准任务；若本次 macOS 截图门禁顺带发现明显失调，另开任务处理，不得混入本次 diff。
- macOS 全屏时系统红绿灯自动隐藏而 `--tl-inset` 净空仍在（左上留白）——与主流应用行为一致，暂不处理。
- Linux 侧栏顶栏 `justify-end` 在原生框下左侧留空——纯装饰性，暂不处理。
