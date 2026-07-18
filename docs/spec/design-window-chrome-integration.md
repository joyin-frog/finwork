# Windows 窗口控制区与应用外壳融合 Spec

> 版本：v1.0 / 2026-07-18
> 状态：待实施
> 基线提交：`9d67a8d`（先冻结此前 UI 一致性改动）
> 影响范围：桌面应用外壳；不恢复应用级顶部标签栏

## 1. 背景

Windows 目前使用无边框窗口，并在 Web UI 顶部渲染一条独立的 32px `WindowTitleBar`。该标题栏位于侧栏和主内容横排之前，因此三枚窗口按钮虽然只占右上角，却会把侧栏与主内容整体向下推，造成整条顶部空白。

macOS 当前由 Tauri 使用系统红绿灯、Overlay 标题栏和固定位置 `(12, 24)`；侧栏顶部已为红绿灯留出安全区，现有观感和拖动体验符合预期。

本次只优化 Windows 的壳层排布：让侧栏顶到窗口顶部，同时把 Windows 窗口控制区收进右侧主工作区。经典和现代风格共享同一套窗口几何，风格只决定表面、边距、圆角和阴影。

## 2. 目标

- Windows 经典风格下，侧栏不再被独立标题栏压低，展开态顶部回到窗口上缘（仍保留经典风格既有的 4px 卡片外边距）。
- Windows 现代风格下，复用原顶部标签栏所在的外壳位置承载拖动区和三枚窗口按钮，但不恢复标签内容。
- Windows 经典和现代统一使用 40px 窗口控制高度。
- Windows 侧栏顶部控制区同步为 40px，使左右两列顶部基线一致。
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
- 关闭按钮仅在 hover/focus-visible 时使用现有 destructive 语义色；其他状态继续使用普通前景色。
- 保留当前最大化状态监听，窗口缩放后继续切换“最大化/还原”图标。

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

## 5. 预计改动文件

| 文件 | 改动 |
|---|---|
| `app/shared/app-shell.tsx` | 外壳改为横排；新增几何中性的 `.app-workspace`；把 `WindowTitleBar` 移入主工作区并置于 `main` 之前 |
| `app/shared/window-controls.tsx` | 标题栏高度改走 Token；调整按钮点击区和图标尺寸；更新注释；功能调用与平台判断不变 |
| `app/globals.css` | 新增 `--window-chrome-height`；Windows 侧栏顶栏同步高度；经典/现代只做表面和分隔策略映射 |
| `tests/window-chrome-layout.test.ts` | 新增壳层顺序、统一高度、macOS 不变和双风格无分叉的源码契约 |
| `tests/window-controls.test.tsx` | 模拟 Tauri Window API，验证三个按钮和最大化状态切换行为；若现有测试环境无法可靠挂载客户端组件，改为最小可测试控制器并记录原因 |
| `tests/all.test.ts` | 注册新增测试 |
| `docs/ui-conventions.md` | 记录“平台窗口系统几何独立于界面风格”的约束 |

除非测试暴露真实缺口，不修改 `src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json` 或 capability 配置。

## 6. TDD 实施顺序

1. 写 `window-chrome-layout` 红测试，锁定：`AppNav` 与 `.app-workspace` 同级，`WindowTitleBar` 位于工作区内且在 `main` 前。
2. 写统一高度红测试，禁止经典/现代分别出现标题栏高度常量；Windows `.app-nav-topbar` 与 `.app-titlebar` 必须消费同一 Token。
3. 最小调整 `AppShell` 结构使测试转绿，先不改按钮视觉。
4. 在 `?winchrome=1` 下验证经典/现代、侧栏展开/收起和拖宽；修复布局回归。
5. 写窗口按钮行为测试，再调整点击区和图标尺寸；功能调用必须保持绿。
6. 在 macOS Tauri 开发态对比基线，确认两种风格的红绿灯、拖动、双击和内容几何无变化。
7. 在 Windows 打包态完成最终窗口功能冒烟；未完成真实 Windows 验证时不得宣称功能已完全验证。

## 7. 验收标准

### 7.1 视觉与布局

- [ ] Windows 经典：侧栏顶部不再出现由全宽标题栏造成的空白；侧栏经典卡片仍保留既有 4px 外边距。
- [ ] Windows 现代：侧栏、窗口控制区和窗口外壳连续使用 `--sidebar`；主卡位置、圆角和边距无回归。
- [ ] Windows 两种风格的窗口控制区和侧栏顶部高度均为40px，切换风格时三件套不跳动。
- [ ] 三个按钮点击区为44px × 40px，图标视觉尺寸符合 §4.3。
- [ ] 侧栏展开、收起和拖宽后，三件套始终贴主工作区右端，不出现基于旧侧栏宽度的空洞。
- [ ] macOS 经典/现代与基线截图一致，红绿灯仍在左侧既有位置。

### 7.2 窗口行为

- [ ] Windows 最小化按钮有效。
- [ ] Windows 最大化按钮有效，最大化后图标切为还原；还原后切回最大化。
- [ ] Windows 关闭按钮有效。
- [ ] Windows 可从主工作区标题栏空白处拖动。
- [ ] Windows 可从侧栏顶部空白处拖动。
- [ ] 双击上述两个拖动区均可最大化/还原，且一次双击只切换一次。
- [ ] 按下三枚按钮不会启动窗口拖动。
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

- **macOS 几何回归**：新增工作区包装层若意外形成滚动容器或 stacking context，会改变现有体验。包装层禁止 `overflow-auto`、`transform`、margin 和 padding，并以 macOS 前后截图为门禁。
- **页面右上角碰撞**：窗口控制区保持独立工作区行，不覆盖业务页面标题栏，从结构上消除碰撞。
- **双击重复触发**：不同时使用 Tauri 拖动区内建切换和 React `onDoubleClick`。
- **按钮与拖动冲突**：行为测试必须确认按钮点击只调用对应 Window API。
- **现代双分隔线**：现代标题栏不额外叠加强分隔；以主卡上边界完成层次。
- **开发预览假绿**：`?winchrome=1` 只能验证几何和视觉，不能替代真实 Windows Tauri 功能测试。

## 9. 历史 Spec 关系

- `spec-linear-tabbar.md` 与 `spec-JOY-10-conversation-tabs.md` 中关于“Windows 标题栏位于标签栏之上、横贯全宽”的结构描述已过时；历史实现记录保留，但本 Spec 在窗口壳层排布上具有更高优先级。
- 应用级顶部标签栏已删除，本任务不得以窗口适配为由恢复。
