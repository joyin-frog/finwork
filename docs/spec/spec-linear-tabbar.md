# Linear 风格顶部标签条（V1 单标签）Spec

> 版本 v1.1 / 2026-07-08（v1.0 经计划审查修订：补七值图标/文案映射表、拍板顶部叠放、显隐改 hidden 工具类方案、特异性账、类型内联声明、DragHandle 隐藏父元素风险）
> 状态：已批准（计划审查 fix first 项已全部修订）
> 依赖：spec-linear-style.md（data-style 双风格、.app-side/.app-main/.app-titlebar 语义类、--shell-canvas 背板）
> 架构事实（写给全新上下文的子代理）：
> - Tauri 桌面应用。窗口拖拽用 `data-tauri-drag-region`；`DragHandle`（app/shared/window-controls.tsx:13）挂载后给**父元素**加该属性。
> - mac 红绿灯是系统绘制、悬浮窗口左上角；现状由侧栏顶条（app/shared/app-nav.tsx:227 `.app-nav-topbar h-11 justify-end`）留出左侧空档。Windows 无红绿灯，`:root[data-platform="windows"] .app-nav-topbar` 规则（globals.css）把它改为靠左。`data-platform` 由 useDetectPlatform 挂到 `<html>`。
> - Windows 自绘标题栏 WindowTitleBar（window-controls.tsx:110 附近）是最顶部独立 h-8 横条（非 Windows 返回 null），带 `.app-titlebar` 语义类，linear 下背景走 --shell-canvas。
> - 外壳结构（app/shared/app-shell.tsx:113 起）：`div(bg-shell-canvas 竖排) > WindowTitleBar + div(横排) > AppNav + main.app-main`。
> - 风格体系铁律：语义类默认零样式；linear 差异全部写在 globals.css 末尾挂载区（暗色用 `html.dark[data-style='linear']` 组合选择器；注释内禁止出现 CSS 注释结束序列）。默认风格像素零变化是硬标准。
> - AppShell 已计算 `active`（cockpit/chat/knowledge/config/files/agents/skills）传给 AppNav；导航中文名见 app-nav.tsx 菜单项文案（总览/对话/知识库/文件/智能体/技能/设置，以代码实际文案为准）。

## 0. 目标与非目标

**目标**：给 Linear 风格加顶部标签条（`.app-tabbar`）：位于（Windows 标题栏之下）侧栏+主区之上、横贯全宽的背板层横条，V1 只渲染**一个标签**=当前页面（图标+中文名），mac 下与红绿灯水平共线，整条可拖拽窗口。默认风格 `display:none`，像素零变化。

**非目标（已知并接受）**：
- 多标签（打开集合、切换、关闭、持久化、快捷键）——V1 明确不做，本条只是把结构插槽和视觉停机坪立起来。
- 标签内容深化（如 chat 显示会话标题）——V1 用页面级名称。
- Windows 下标签条与三键标题栏合并成一条（浏览器式）——V1 接受"标题栏+标签条"两条叠放，合并留待多标签时评估。
- 默认风格显示标签条——不做，显隐属于风格差异。

## 1. 成功标准

- [ ] 默认风格亮/暗：DOM 中有 `.app-tabbar` 但不可见（`hidden` 工具类生效），cockpit/chat 截图与改动前一致（像素零变化）。
- [ ] Linear 下左侧「标签条→侧栏顶条→导航项」叠放符合拍板（见 §3），截图确认观感可接受。
- [ ] Linear 亮/暗（mac）：顶部出现 40px 背板色横条，左侧留红绿灯空档（约 pl-20），随后是当前页标签（浮起卡面色小圆角 chip，含图标+页名）；主内容卡在其下方，上缝仍 8px；切换到 /knowledge 等页标签文案跟随。截图验证。
- [ ] Linear 下侧栏顶条不再为红绿灯留左空档（红绿灯已由标签条承接），收起/搜索按钮不与红绿灯重叠。
- [ ] `:root[data-platform="windows"]`：标签条左侧不留红绿灯空档（复用既有平台规则模式，代码走查即可，mac 无法实跑）。
- [ ] 标签条整条是窗口拖拽区（DragHandle 挂载；浏览器 preview 无法验证拖拽，代码走查 + audit 注明）。
- [ ] npm run lint / npm run typecheck / FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test 全绿。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/shared/app-tab-bar.tsx` | 新增 | AppTabBar 组件：`.app-tabbar` 容器 + DragHandle + 单标签 chip |
| `app/shared/app-shell.tsx` | 修改 | WindowTitleBar 与横排行之间挂 `<AppTabBar active={active} />` |
| `app/globals.css` | 修改 | 基础规则 `.app-tabbar { display:none }`；linear 块内显隐+样式；linear 下 `.app-nav-topbar` 收掉红绿灯空档；`:root[data-platform="windows"] .app-tabbar` 左侧不留空档 |
| `docs/spec/audit-linear-tabbar.md` | 新增 | implementer 产出 |

## 3. 实施步骤

1. **AppTabBar 组件**（新文件，"use client"）：
   - Props：`active`（与 AppShell 现有 active 联合类型一致）。
   - 结构：
     ```tsx
     <div className="app-tabbar relative shrink-0 items-center gap-2">
       <DragHandle />
       <div className="app-tab flex items-center gap-1.5 px-3 h-7 text-small">
         <HugeiconsIcon icon={<对应图标>} className="size-3.5" />
         <span>{LABEL[active]}</span>
       </div>
     </div>
     ```
   - 图标与文案：**按下表实现，不要从 app-nav 菜单"照抄"**（导航菜单与页面标签语义不同：chat 菜单项是"新对话"、config 行显示用户名，直接照抄会错）。LABEL/ICON 两个映射表写在本组件内：

     | active | 文案 | 图标 |
     |---|---|---|
     | cockpit | 总览 | DashboardSquare02Icon |
     | chat | 对话 | @hugeicons/core-free-icons 的常规聊天气泡图标（如 BubbleChatIcon；若该名不存在则退回 ChatAddIcon） |
     | knowledge | 知识库 | LibraryIcon |
     | files | 文件 | 先 grep app/files/page.tsx 已 import 的代表性文件/文件夹图标复用之；没有合适的则退回 LibraryIcon |
     | agents | 智能体 | UserGroupIcon |
     | skills | 技能 | NoteIcon |
     | config | 设置 | Settings02Icon |

   - `active` 的联合类型：**在本组件内联重复声明**（照 app-shell.tsx:90 的现状写法）；app-nav.tsx 的 NavActive 未导出，**不要为此去改 app-nav.tsx**（它不在 Files touched）。
   - 显隐机制：容器 className 写 `app-tabbar hidden`——`hidden` 是 @layer utilities 里的工具类，会被挂载区**无 layer** 的 `[data-style='linear'] .app-tabbar { display:flex }` 无条件压过（无 layer 规则优先于任意 layer 规则），默认风格即隐藏、linear 即显示，globals.css 基础区不需要加任何规则，语义类默认零样式铁律不破。chip 的尺寸类（h-7/px-3/gap-1.5/text-small）留在 TSX：它是 linear 专属元素，没有双风格分叉需求，不必进 CSS。
   - DragHandle 会给父元素挂 data-tauri-drag-region；chip 是子元素，Tauri 下按下子元素不触发拖拽（与 WindowTitleBar 同机制）。
2. **app-shell.tsx**：`<WindowTitleBar />` 之后、横排 div 之前插入 `<AppTabBar active={active} />`（active 变量已有）。
3. **globals.css**（只动挂载区，基础区不加规则——显隐由组件的 `hidden` 工具类 + 挂载区覆盖完成，见步骤 1）：
   - linear 挂载区追加：
     ```css
     [data-style='linear'] .app-tabbar {
       display: flex;
       height: 2.5rem;                /* 40px,mac 红绿灯垂直居中共线 */
       padding-left: 5rem;            /* mac 红绿灯空档(约 80px) */
       padding-right: 0.5rem;
       background: var(--shell-canvas);
     }
     [data-style='linear'] .app-tab {
       background: var(--background);  /* 与浮起卡同面色,"活动标签连着卡"的暗示 */
       border: 1px solid var(--border);
       border-radius: var(--radius-md);
     }
     /* 红绿灯已由标签条承接,侧栏顶条收掉左空档(复用 Windows 平台规则的既有做法) */
     [data-style='linear'] .app-nav-topbar { justify-content: flex-start; padding-left: 0.5rem; }
     /* Windows 无红绿灯:标签条不留空档(三键在上方独立标题栏) */
     :root[data-platform="windows"] .app-tabbar { padding-left: 0.5rem; }
     ```
     暗色无需单独覆盖（全部走 token）。特异性账：Windows 规则 `:root[data-platform] .app-tabbar` = (0,3,0)，高于 linear 规则 `[data-style] .app-tabbar` = (0,2,0)，**与书写顺序无关必胜**，无需额外保障。
   - **顶部叠放拍板**：linear 下左侧纵向为「标签条 40px → 侧栏顶条 44px（含搜索/收起按钮，类似 Linear 侧栏自己的头部行）→ 导航项」，与右侧浮起卡顶（48px）错位属预期，**接受此叠放**。目检若顶条观感空旷，允许在 linear 块内把 `.app-nav-topbar` 高度收紧至 36px（`height: 2.25rem`）级别，微调即可，记入 audit——不要为对齐重排结构。
4. **实机校准**：linear 亮/暗下截图确认标签 chip 与红绿灯共线、与浮起卡观感协调；`.app-main` 的 margin 维持 0.5rem 不动（标签条与卡之间正好 8px 缝）。若 40px/pl-20 与红绿灯错位，微调数值为准并记入 audit。

## 4. 测试与验证

```bash
npm run lint
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```
（worktree 跑 test 需 workers/.venv 符号链接，已建好。）

preview_* 工具（勿 Bash 起 server）：
- 默认亮色 /cockpit 与 /chat 截图对比零变化；DOM 里确认 .app-tabbar 存在且 display none。
- preview_eval 切 dataset.style="linear"：/cockpit、/knowledge、/agents 各截一张，确认标签文案随页切换、亮暗两态无破版。
- 拖拽与红绿灯共线无法在浏览器验证：代码走查 + audit 注明"需 tauri:dev 实机确认"。

## 5. 风险与开放问题

- **红绿灯精确共线**：系统红绿灯纵向位置随 Tauri 窗口配置而定，40px 条高 + 居中 chip 是按常规 overlay 样式估的，实机（tauri:dev）可能需要 ±4px 微调——留给 audit 记录，不阻塞。
- **两个拖拽区并存**（标签条 + 侧栏顶条 DragHandle）：Tauri 允许多个 drag region，无冲突；linear 下侧栏顶条仍保留 DragHandle 无妨。
- **collapsed 侧栏**：标签条在侧栏之上横贯全宽，收起侧栏不影响它；目检确认。
- **ChatFloat/Toaster**：fixed 定位相对视口，标签条加入后 top 类坐标未变（它们本来就避开顶部），目检 chat 页浮窗不被遮挡。
- **e2e**：若 playwright 用例断言外壳 DOM 顺序，可能受新节点影响——跑 npm test 即可暴露（e2e 不在默认 test 内，本任务不跑 test:e2e，记入 audit）。
- **DragHandle 挂在默认风格 display:none 的父元素上**：隐藏元素 rect 为零，Tauri 对零面积 drag region 静默忽略，无害；linear 显示后恢复正常。
