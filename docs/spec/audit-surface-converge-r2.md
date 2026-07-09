# audit-surface-converge-r2

## Files changed

| 文件 | 变更 |
|---|---|
| `app/chat/chat-file-panel.tsx` | 浮层 div 迁 Surface(level="overlay" edge="none" shape="panel")；新增 Surface import |
| `app/agents/page.tsx` | :221 `p-6` → `p-page` |
| `docs/spec/audit-surface-converge-r2.md` | 本文件 |

---

## 逐文件枚举表

### 1. `app/chat/find-in-chat.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :203 | **浮层容器** | `rounded-xl border border-border bg-card shadow-[var(--elevation-2)] px-2 py-1.5` | **保留** | `shadow-[var(--elevation-2)]` 无对应 Surface level（card/panel 产出 elevation-1，overlay 产出 elevation-3）；若加 className="shadow-[var(--elevation-2)]" 覆盖 elevation-1，Tailwind 生成顺序不保证后者胜出，有像素变化风险；保留原样零变化 |
| :220–237 | 图标按钮（×3） | `rounded p-0.5` | 跳过 | 交互控件圆角，非容器 surface |

### 2. `app/chat/chat-file-browser.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :162–163 | bordered 行容器（条件）| `rounded-lg border border-border bg-card px-1.5 py-1`（`bordered && ...`）| **保留** | 原始无 shadow；Surface card/panel level 均产出 shadow-elevation-1，需 shadow-none 补差——但 shadow-none 与 shadow-elevation-1 的 CSS 胜出顺序依赖 Tailwind 构建阶段排列，不确定；且 bordered 是条件 className（非顶层容器），迁 Surface 需整体重构条件渲染结构，属结构变更而非类替换；保留原样 |
| :179, :183 | chip（徽章） | `rounded-full bg-muted` | 跳过 | bg-muted 不属 surface 族（bg-card/bg-popover/bg-background）；rounded-full 为装饰圆角 |
| :214 | 应用图标占位 | `rounded bg-muted` | 跳过 | 小图标徽章，非容器 |

### 3. `app/chat/chat-file-panel.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 变体组合 |
|---|---|---|---|---|
| :52（原 div，现 Surface）| **浮层容器** | `rounded-xl bg-popover shadow-[var(--elevation-3)]`（无 border）| **迁移** | `level="overlay" edge="none" shape="panel"` → 产出 `bg-popover shadow-[var(--elevation-3)] rounded-xl` **完全等值**，0 项 className 补差；非 surface 的定位/尺寸/overflow/padding 留在 className |

等值验证：
- `level="overlay"` → `bg-popover shadow-[var(--elevation-3)]` ✓
- `edge="none"` → `""` ✓（原无 border）
- `shape="panel"` → `rounded-xl` ✓

### 4. `app/cockpit/team-growth-hint.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :15–19 | 卡根容器 | 已使用 `<Surface level="card" edge="hairline" shape="card">` | 已完成，无需变更 | 上一批已迁移；px-4 py-5 非对称保留在 className 符合规则 |

### 5. `app/shared/app-nav.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :220 | aside 容器 | 已使用 `surfaceVariants({ level: "panel", edge: "hairline", shape: "panel" })` | 已完成，无需变更 | 已用 surfaceVariants；bg-sidebar className 覆盖为有意设计 |
| :114, :187, :235, :245 | 导航链接/图标按钮 | `rounded-md`、`rounded-lg`、`rounded` | 跳过 | 交互控件圆角，非容器 surface |
| :149 | 状态点 | `rounded-full` | 跳过 | 装饰圆圈，非容器 |

### 6. `app/shared/chat-float.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :165–173 | 浮窗容器 | 已使用 `<Surface level="overlay" edge="hairline" shape="panel">` | 已完成，无需变更 | 已用 Surface；className 中 `bg-card` 覆盖是有意的（浮窗底色用 card 而非 popover），保留 |
| :157 | 圆钮 | `rounded-full bg-primary` | 跳过 | 交互按钮，非容器 surface；bg-primary 不属 surface 族 |
| :183, :191 | 图标按钮 | `rounded` | 跳过 | 交互控件 |
| :206 | 用户气泡 | `rounded-lg bg-primary` | 跳过 | 消息气泡用品牌色，非 surface 容器 |

### 7. `app/components/checklist-card.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :161, :179 | 卡根容器（×2）| 已使用 `<Surface className="shadow-none ...">` | 已完成，无需变更 | shadow-none 覆盖为有意设计（清单卡无阴影）|
| :217–221 | 三态按钮 | `rounded-[var(--radius-chip)] border` | 跳过 | 交互控件（toggle button） |

### 8. `app/shared/page-search-dialog.tsx`（实际为 PageSearchBar）

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :39 | 包装行 div | `border-b border-border` | 跳过 | 仅底部描边分隔行，不含 bg-card/bg-popover，不属容器 surface |
| :43 | 搜索 form | `rounded-lg border border-input bg-background px-3 shadow-xs` | 跳过 | 交互控件（search input 容器）；`border-input` 非 `border-border`；按 spec "交互控件不动" |

### 9. `app/components/ask-user-card.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :64 | 确认卡根 | 已使用 `surfaceVariants({ level: "card", edge: "none", shape: "card" })` | 已完成，无需变更 | border-primary/30 bg-primary/5 为有意的主色调覆盖 |
| :93 | 选项按钮 | `rounded-full border border-border bg-card` | 跳过 | 交互控件（选项按钮），非容器 surface |

### 10. `app/components/ask-user-panel.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :136, :190 | 面板根（×2）| 已使用 `<Surface level="card" edge="hairline" shape="overlay">` | 已完成，无需变更 | shape="overlay"（rounded-2xl）搭配 shadow-none 为有意设计（面板无浮起阴影但大圆角） |
| :157 | 进度点 | `rounded-full` | 跳过 | 装饰圆圈 |
| :205 | 序号圆 | `rounded-full border` | 跳过 | 交互控件内的序号徽章 |

### 11. `app/knowledge/page.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :42–50 (MetaStatusBadge) | 状态徽章 | 已使用 `<Surface level="page" edge="none" shape="chip">` | 已完成 | |
| :95 | 元数据面板头部条 | `border-b border-border bg-card` | **保留** | 仅 border-b（单边）；Surface hairline 产出全边 border，迁移会添加三条新边，视觉变化；同时 bg-card 无 shadow，Surface level="card" 会加 shadow-elevation-1，需 shadow-none 补差——shadow override 不确定 |
| :141 | 日期类型 chip | 已使用 `<Surface level="page" edge="none" shape="chip">` | 已完成 | |
| :654, :717 | 预览头部条（×2）| `border-b border-border bg-card` | **保留** | 同 :95，单边 border 无法等值迁移 |
| :971, :972 | 归档/延期 chip（×2）| 已使用 `<Surface level="page" edge="none" shape="chip">` | 已完成 | |
| 各处按钮 | 操作按钮、分类 chip 按钮、上传按钮 | `rounded-md`、`rounded-full`、`rounded-xl` 等 | 跳过 | 交互控件 |

### 12. `app/knowledge/doc-card.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 理由 |
|---|---|---|---|---|
| :29–33 | 文档卡 article | `rounded-lg border` + 动态 `border-primary bg-accent` / `border-border hover:bg-accent/40` | **保留** | 无 bg-card/bg-popover 基础色；active/hover 状态使用 bg-accent（非 surface 色），不属 surface 族迁移目标；动态 border 颜色由状态驱动，无法静态映射到 edge 变体 |
| :49 | 归档徽章 | `rounded bg-muted` | 跳过 | bg-muted 非 surface 族 |
| :55–78 | 操作按钮（×4）| `rounded-md border border-border` | 跳过 | 交互控件 |

### 13. `app/agents/page.tsx`

| file:line | 元素角色 | 原始类 | 处置 | 变更 |
|---|---|---|---|---|
| :221 | 骨架容器内边距 | `p-6` | **迁移** | → `p-page`；default 风格：p-page = --page-pad = 1.5rem = p-6（零变化）；linear 风格：p-page = 1rem（密度收紧，符合 spec 意图）|
| :221 | `gap-5` | `gap-5`（1.25rem）| **保留** | 与 --section-gap 1.5rem 不等值，spec 明确标注保留 |

---

## 与计划的偏差

| 偏差 | 说明 |
|---|---|
| `find-in-chat.tsx` 未迁 | shadow-[var(--elevation-2)] 无 Surface 等值 level；保留原样符合"零变化优先于收敛完成度"规则 |
| `chat-file-browser.tsx` bordered 行未迁 | bg-card 无 shadow 版本在 Surface 没有直接对应；条件 className 结构迁移需结构重构；保留 |
| `knowledge/page.tsx` 三处 border-b 头部条未迁 | 单边 border 与 Surface hairline（全边）不等值；shadow override 不确定；保留 |
| `knowledge/doc-card.tsx` article 未迁 | 无 bg-card/bg-popover，动态 bg-accent 非 surface 族；保留 |
| `page-search-dialog.tsx` form 未迁 | 交互控件（search form），按 spec 非目标 |
| 其余文件已使用 Surface/surfaceVariants | team-growth-hint / chat-float / checklist-card / ask-user-card / ask-user-panel / app-nav 均上一批已完成，无需本批改动 |

---

## 测试结果

```
npm run lint      → 0 errors, 144 warnings（均为存量；无新告警）
npm run typecheck → 通过（无输出）
npm test          → 11 pass, 0 fail（FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true）
```

---

## 视觉验证

| 页面 | 默认风格 | Linear 风格 |
|---|---|---|
| /chat/new | 截图目检通过，布局无变化 | 截图目检通过 |
| /knowledge | 截图目检通过，卡片网格无变化 | 截图目检通过，hairline 卡片跟随 token |
| /agents | 截图目检通过，p-page 生效（default=24px=p-6 零变化） | 截图目检通过，p-page=1rem 密度收紧符合 spec |

**浮层类（find-in-chat、chat-file-panel、chat-float）**：需用户交互触发，未在 preview 中实机触发；通过 typecheck 和代码逐行审查确认结构正确。chat-file-panel 迁移的 Surface 已通过 TypeScript 验证，Surface 组件接受所有 div 透传 props（role、aria-label、style）。

---

## 开放风险

| 风险 | 级别 | 说明 |
|---|---|---|
| chat-file-panel 浮层视觉未实机截图 | 低 | 触发需点击附件按钮；TypeScript 和代码审查已确认等值迁移 |
| find-in-chat、chat-file-browser bordered 行存量手写 surface 类 | 低 | shadow-[var(--elevation-2)] 和 shadow-none 覆盖不确定是已知限制；下一批若补 Surface level 档可重拾 |
| knowledge/page.tsx 三处 border-b 头部条 | 低 | 需在 Surface 中支持非对称边框后方可迁移（超出本批范围） |
