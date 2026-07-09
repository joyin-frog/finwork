# Surface 收敛第二批（手写 surface 样式迁移 + agents 页骨架间距）Spec

> 版本 v1.0 / 2026-07-08
> 状态：已批准（与前两批同构的机械迁移，计划审查省略，实施审查照常）
> 依赖：spec-linear-style.md（data-style 双风格）、密度 token 批（--surface-pad/--page-pad/--section-gap/--card-gap、Surface pad 变体，均已在工作树）
> 架构事实：Surface 原语见 components/ui/surface.tsx（level: page/panel/card/overlay；edge: none/hairline/strong；shape: none/chip/control/card/panel/overlay/pill；pad: none/card/compact）。变体产出的类：card=bg-card+elevation-1，overlay=bg-popover+elevation-3，hairline=border+border-border，shape card=rounded-lg / panel=rounded-xl / overlay=rounded-2xl。项目双风格靠 token 切换，页面手写 bg-card/rounded/shadow 会脱离风格体系，故收敛。

## 0. 目标与非目标

**目标**：把 app/ 下仍手写 surface 族样式（bg-card/bg-popover + rounded-lg/xl/2xl + border + shadow 组合）的容器迁到 Surface 原语（或 surfaceVariants），使其完整进入 token/风格体系；agents 页骨架间距采用密度工具类。**默认风格像素零变化是硬标准。**

**非目标**：
- 交互控件（按钮/输入/菜单项/图标钮）上的 rounded-* 不属 surface 族，不动。
- 非对称内边距（px-4 py-3 / px-4 py-5 等）不硬套 pad 变体，保留原 class（本轮 team-panel 已踩过：pad 变体是对称的，硬套会改默认像素）。
- shadcn 组件（Card/Dialog/Popover 等）内部样式不动。
- dev/theme 调试台不动。

## 1. 成功标准

- [ ] 处理完下列候选文件中所有 surface 族容器：每处要么迁 Surface（变体+className 补差后与原产出类**等值**），要么保留并在 audit 记录保留理由。
- [ ] 默认风格亮/暗下 chat、knowledge、agents 三页与改动前视觉一致（截图对比）。
- [ ] linear 风格下上述页面卡片/浮层跟随风格 token（灰背板色系、圆角、发丝线），无破版。
- [ ] npm run lint（0 新告警）、npm run typecheck、FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test 全绿。

## 2. Files touched（候选，实际以逐文件枚举为准；只许动此列表）

| 文件 | 预期 |
|---|---|
| app/chat/find-in-chat.tsx | 浮层 → Surface overlay 族 |
| app/chat/chat-file-browser.tsx | 面板/卡 |
| app/chat/chat-file-panel.tsx | 浮层 |
| app/cockpit/team-growth-hint.tsx | 卡根迁 Surface，px-4 py-5 保留 |
| app/shared/app-nav.tsx | 甄别：命中多为图标钮 rounded-lg，大概率整文件不动 |
| app/shared/chat-float.tsx | 浮窗 → overlay 族 |
| app/components/checklist-card.tsx | 卡 |
| app/shared/page-search-dialog.tsx | 浮层 |
| app/components/ask-user-card.tsx | 卡 |
| app/components/ask-user-panel.tsx | 卡/面板 |
| app/knowledge/page.tsx | 卡 + 甄别 |
| app/knowledge/doc-card.tsx | 卡 |
| app/agents/page.tsx | 仅骨架间距：:221 `p-6` → `p-page`；同行 `gap-5`（1.25rem，与 --section-gap 1.5rem 不等值）**保留** |
| docs/spec/audit-surface-converge-r2.md | implementer 产出 |

## 3. 实施规则（逐文件先枚举后改）

1. 对每个候选文件 grep surface 族类，**逐元素**判断：是"容器表面"（卡片/面板/浮层/抽屉）还是"控件圆角"（按钮/输入/行 hover）。只动前者。
2. 容器迁移映射：现状类组合 → 最接近的 Surface 变体；变体产出与现状的差异项用 className 补（如现状 rounded-xl 卡 → shape="panel"；现状无阴影 → level 对应后 className 加 shadow-none 不如保留原样——**若补差超过 2 项，保留原样并记录**，宁可保守）。
3. 对称 p-4/p-3 卡根 → pad="card"/"compact" 并从 className 移除；其余 padding 一律原样。
4. bg-popover+大阴影浮层 → level="overlay" shape="overlay"（rounded-2xl 等值）；若现状 rounded-lg/xl 则 shape 取等值档，**不升级圆角**。
5. audit 必须含完整枚举表：file:line、原类、处置（变体组合/保留+理由）。

## 4. 测试与验证

```bash
npm run lint
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```
preview_* 工具（勿用 Bash 起 server）：默认亮色截 chat/knowledge/agents 对比零变化；preview_eval 切 dataset.style="linear" 复查三页。浮层类（find-in-chat、page-search-dialog、chat-float）尽量实机触发目检；触发不到的在 audit 注明。

## 5. 风险与开放问题

- 等值判断是本批唯一风险源：变体产出类与原类不完全等值时宁可保留原样，零变化标准优先于收敛完成度。
- chat-float 是全局浮窗，改动后需确认拖拽/层级(z-index)不受影响（Surface 不带定位，定位类留在 className）。
