# Audit: linear-polish-r2 Batch A

## Files changed

| 文件 | 改动 |
|---|---|
| `app/globals.css` | 新增 `.app-page-header` 底线类；§3.1 linear `.app-sidebar-toggle` padding→display:none；§3.7 删亮色 --primary/--primary-foreground/--ring、删暗色 --primary/--ring；§3.9 新增两条预览全屏选择器 |
| `app/cockpit/page.tsx` | header className 追加 `app-page-header` |
| `app/chat/chat-page.tsx` | header className 追加 `app-page-header` |
| `app/agents/page.tsx` | header className 追加 `app-page-header` |
| `app/knowledge/page.tsx` | header `border-b border-border` 替换为 `app-page-header`；分类 chip 行删 `border-b border-border` |
| `app/files/page.tsx` | header `border-b border-border` 替换为 `app-page-header`；filter chips 行删 `border-b border-border` |
| `app/config/tabs.ts` | `label: "键盘快捷键"` → `label: "快捷键"` |

## 各处说明

**§3.1（点1）** `[data-style='linear'] .app-sidebar-toggle` 由 `padding-left:0.25rem` 改为 `display:none`。注释更新为"展开入口在标签条，内容页头的展开按钮多余，linear 下隐藏"。

**§3.2（点2）** 在 `.icon-btn` 前新增 `.app-page-header { border-bottom: 1px solid var(--border); }`（无 layer，特异性 0,1,0）。cockpit/chat/agents 三页 header 追加类名（它们原无 border，这是有意的全局一致化变更）。knowledge/files 两页 header 的 `border-b border-border` 替换为 `app-page-header`（避免双份底线，其余 overflow 类保留）。border 取值：使用 `var(--border)` 起步值（亮色 `oklch(0.95 0 0)`，与 knowledge/files 原底线等值，因此这三页改后视觉不会更重）。**实测底线**：cockpit/chat/agents 三页底线使用相同 `var(--border)` token，值与 knowledge/files 已有底线完全一致，视觉上一致可辨；无需微调。spec §3.2 中 `color-mix` 备选值未使用（原值已满足"细淡但可见"的统一要求）。

**§3.3（点3）** knowledge/page.tsx 分类 chip 行删 `border-b border-border`；files/page.tsx filter chips 行删 `border-b border-border`。其余 overflow/scrollbar 类保留。

**§3.6（点6）** `tabs.ts` 第19行 `label: "键盘快捷键"` → `label: "快捷键"`。key `shortcuts` 不动，深链兼容。

**§3.7-color（点7）** 亮色 `[data-style='linear']` 块删三行：`--primary`、`--primary-foreground`、`--ring`。暗色 `html.dark[data-style='linear']` 块删两行：`--primary`、`--ring`。保留：--shell-canvas、--border、--radius、密度 token、--sidebar:transparent、暗色中性表面色系（--background/--card/--popover/--foreground/--muted-foreground/--input）、--elevation-*、全部 .app-* 布局规则。切 linear 后主色回默认蓝 `oklch(0.546 0.215 262.9)`，暗色灰回 `oklch(0.62 0.19 262.9)`，薰衣草紫 `oklch(0.545 0.145 277)` 不再出现。

**§3.9（点9）** linear 挂载区末尾追加两条选择器：`.preview-card-frame.is-maximized` 与 `.preview-page-shell.is-docked.is-maximized`，设 margin:0/border-radius:0/border:none/box-shadow:none/height:100%。覆盖两条全屏路径（resizable-preview-panel 列容器 + file-preview-page shell），默认风格不受影响。CSS 注释内无 `*/` 序列。

## 与计划的偏差

- `app/config/skill-center.tsx` 未动。spec §3.2 要求其 header `border-b border-border` → `app-page-header`，但任务指令已明确将 skill-center.tsx 移交批 B 一并处理，**本 audit 注明：skill-center.tsx 的 §3.2 header 替换移交批 B**。
- 点2 border 颜色最终取 `var(--border)` 未使用 `color-mix` 备选——原值与 knowledge/files 已有底线等值，实测一致可辨，无需调深。

## 测试结果

- `npm run lint`：0 errors, 148 warnings（均为预存警告，无新增）
- `npm run typecheck`：app/ 与 lib/ 源码 0 errors；`src-tauri/` 构建产物的 TS 错误为预存问题，不在本次改动范围
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`：9 pass, 0 fail

## 开放风险

- `.app-page-header` 底线在 Linear 风格下受 `--border: oklch(0.90 0.004 260)` 覆盖（略深于默认亮色的 0.95），亮色 linear 下底线会稍明显，视觉上更实，与 Linear 整体设计（描边而非阴影）一致。
- 点2 cockpit/chat/agents 三页新增底线属有意全局变更（spec §0 明确），reviewer 勿作回归处理。
- skill-center.tsx §3.2 改动由批 B 覆盖，config 页 header 暂仍有双份 `border-b border-border`（待批 B 修复）。
