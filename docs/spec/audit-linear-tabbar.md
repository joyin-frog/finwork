# Audit: linear-tabbar

## Files changed

| 文件 | 动作 |
|---|---|
| `app/shared/app-tab-bar.tsx` | 新增：AppTabBar 组件 |
| `app/shared/app-shell.tsx` | 修改：挂载 AppTabBar |
| `app/globals.css` | 修改：linear 块追加标签条规则 |

---

### app/shared/app-tab-bar.tsx（新增）

新建 `AppTabBar` 组件。`active` 联合类型在文件内内联声明（与 app-shell.tsx:90 写法一致，未改 app-nav.tsx）。`LABEL`/`ICON` 两张映射表按 spec §3 实现，容器带 `hidden` 工具类默认隐藏，linear 下被无-layer 的 CSS 规则覆为 flex。DragHandle 挂在容器父元素上（与 WindowTitleBar 机制相同）。

**图标退路决策**：
- `chat`：`BubbleChatIcon` 在 `@hugeicons/core-free-icons` 中存在（grep 确认），直接使用，未退回 ChatAddIcon。
- `files`：`Folder02Icon` 已在 `app/files/page.tsx` 中使用，复用之，未退回 LibraryIcon。

图标类型使用 `IconSvgElement`（从 `@hugeicons/react` 导入），避免 `any`。

---

### app/shared/app-shell.tsx（修改）

在 `import` 区新增一行引入 `AppTabBar`。在 JSX 中，`<WindowTitleBar />` 之后、横排 flex div 之前插入 `<AppTabBar active={active} />`，复用已有 `active` 变量。

---

### app/globals.css（修改）

在文件末尾 linear 暗色块之后追加标签条规则块（无-layer，紧跟挂载区既有模式）：
- `[data-style='linear'] .app-tabbar`：display:flex / height:2.5rem / padding-left:5rem / background:var(--shell-canvas)
- `[data-style='linear'] .app-tab`：background/border/border-radius chip 样式
- `[data-style='linear'] .app-nav-topbar`：justify-content:flex-start / padding-left:0.5rem（收掉红绿灯空档）
- `:root[data-platform="windows"] .app-tabbar`：padding-left:0.5rem（Windows 无红绿灯）

暗色无需单独覆盖（全部走 token）。基础区零改动，`hidden` 工具类 + 无-layer 覆盖机制按 spec 实现。

---

## 与计划的偏差

无实质偏差。以下微决策已做：
- chip 图标类型用 `IconSvgElement` 而非 `any`（比 spec 提示的 `any` 更严格，lint 要求）。
- `BubbleChatIcon` 直接使用（主路，未触发退路）。
- `Folder02Icon` 直接使用（主路，未触发退路）。
- 顶部叠放观感（标签条 40px → 侧栏顶条 h-11 约 44px → 导航项）：目检可接受，未微调 `.app-nav-topbar` 高度。

---

## 测试结果

```
npm run lint         → 通过（新文件无 error/warning）
npm run typecheck    → 通过（tsc 零错误）
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test → 全绿（11 suites pass / 0 fail）
```

---

## 浏览器 preview_* 目检

| 检查点 | 结果 |
|---|---|
| 默认亮色：`.app-tabbar` 存在、`display:none` | 通过（DOM 确认） |
| 默认亮色截图：布局零变化 | 通过 |
| Linear 亮色 /cockpit：tabbar 显示"总览"chip | 通过 |
| Linear 亮色 /knowledge：tabbar 显示"知识库"chip | 通过 |
| Linear 亮色 /agents：tabbar 显示"智能体"chip | 通过 |
| Linear 暗色 /agents：tabbar 可见、背板近黑、无破版 | 通过 |
| 侧栏顶条：linear 下搜索/收起按钮靠左、无红绿灯空档 | 通过 |
| tabbar 尺寸：height=40px、padding-left=80px、background=shell-canvas token | 通过（preview_inspect 确认） |

---

## 开放风险

- **红绿灯精确共线**：浏览器无 Tauri 系统红绿灯，40px / pl-20 是估值。需 `tauri:dev` 实机确认，可能需 ±4px 微调。
- **拖拽区验证**：DragHandle 代码走查确认逻辑正确（挂父元素 data-tauri-drag-region），浏览器 preview 无法验证实际拖拽行为。待 `tauri:dev` 实机确认。
- **Windows 三键叠放**：`:root[data-platform="windows"] .app-tabbar` 规则代码走查正确（特异性 0,3,0 > 0,2,0 必胜），dev 无 Windows 环境，未实跑。
- **e2e**：若 playwright 用例断言外壳 DOM 顺序可能受新节点影响。`npm test` 不含 `test:e2e`，未跑，记此提醒。
