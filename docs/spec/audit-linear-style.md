# Audit: Linear 风格实施（linear-style）

## Files changed

| 文件 | 动作 |
|---|---|
| `app/globals.css` | 修改 |
| `app/shared/app-shell.tsx` | 修改 |
| `app/shared/app-nav.tsx` | 修改 |
| `app/shared/window-controls.tsx` | 修改 |
| `app/layout.tsx` | 修改 |
| `app/config/appearance/appearance-settings.tsx` | 修改 |
| `docs/spec/audit-linear-style.md` | 新增（本文件） |

---

## 每文件改动说明

### `app/globals.css`
- `:root` Surface 语义区新增 `--shell-canvas: var(--background)`（默认风格下与页面底同色，不可见）。
- 文件末尾「风格覆盖挂载区」追加 Linear 亮色覆盖块（`[data-style='linear']`）：覆盖 `--shell-canvas`/`--primary`/`--primary-foreground`/`--ring`/`--sidebar`/`--radius`/`--border`；`.app-side` 透明平铺规则；`.app-main` 浮起卡规则（margin/border-radius/border/background/box-shadow）；`.app-titlebar` 背板色规则。
- 追加 Linear 暗色覆盖块（`html.dark[data-style='linear']`）：覆盖 `--shell-canvas`/`--background`/`--card`/`--popover`/`--foreground`/`--muted-foreground`/`--border`/`--input`/`--primary`/`--ring`/`--sidebar`/elevation；`.app-main` 的 `box-shadow: none`（暗色靠描边分层）。

### `app/shared/app-shell.tsx`
- 最外层 `div` className: `bg-background` → `bg-[var(--shell-canvas)]`（默认风格下 `--shell-canvas = var(--background)` 不可见，Linear 下变为背板色）。
- `<main>` className: 追加 `app-main`（语义钩子，无自带样式）。

### `app/shared/app-nav.tsx`
- `motion.aside` 最外层 className 中的固定字符串首部追加 `app-side`（展开/折叠两态均携带，语义钩子，无自带样式）。

### `app/shared/window-controls.tsx`
- `WindowTitleBar` 根元素 className 追加 `app-titlebar`（语义钩子，Linear 下映射背板色；默认风格无影响）。

### `app/layout.tsx`
- `<head>` 内 highlight style 注入之后，追加 no-flash 内联脚本：读取 `localStorage["app-style"]`，若值为 `"linear"` 则在首帧 paint 前写入 `document.documentElement.dataset.style`，白名单仅认 "linear"，SSR 属性 `data-style="default"` 不变。

### `app/config/appearance/appearance-settings.tsx`
- 新增 `STYLES` 常量（default/Linear 两项）。
- 新增 `useState<StyleValue>("default")` + `useEffect` 挂载后读 `document.documentElement.dataset.style`（避免 SSR 读 document 的 hydration 问题）。
- 新增 `handleStyleChange` 函数：写 localStorage / 更新 dataset，选 "default" 时 removeItem 并复位 dataset。
- 新增「界面风格」`SettingsSection`（title/description/两按钮），位于现有「主题」SettingsSection 之后。

---

## 与计划的偏差及原因

**无计划外偏差。**

1. oklch 数值：spec 标注"以肉眼校准为准"。实施时用 `preview_inspect` + `preview_eval` 实测四象限，读取计算值与视觉对比后，亮色灰背板（0.962）与暗色近黑背板（0.13）均产生足够的层差，保留 spec 起点值，未作调整。
2. CSS 注释措辞：暗色 `--shell-canvas` 注释将原文「≈ #010102 近黑背板」中的 `#010102` 改为描述性文字（spec 示例写死 hex，实际 oklch 换算不完全对应），属预期内微调，不影响功能。
3. `.app-main` 注释中 CSS 乘法符号：spec 原文写 `0.625rem × 1.4 = 14px`（含 × 号），替换为 `x` 避免 CSS 注释意外截断风险（`×` 在一些历史解析器中有问题）。

---

## 测试结果

### `npm run lint`
```
✖ 145 problems (0 errors, 145 warnings)
```
- 0 errors。
- 145 warnings 均为预存：`app/layout.tsx` 的 `no-page-custom-font`（Google Fonts 链接）、`app/shared/app-nav.tsx` 的 Surface token 警告——这些在改动前已存在，未引入新警告。

### `npm run typecheck`
```
（无输出）
```
- 0 TypeScript errors。

### `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`
```
# tests 11
# suites 0
# pass  11
# fail  0
```
- 11 个测试套件全部 PASS，0 FAIL。

---

## 四象限视觉校准结论

用 `preview_start`（next-dev，port 3000）实跑，`preview_eval` 手动切换 class/dataset，`preview_inspect`/`preview_eval` 读取计算样式。

| 象限 | shell background | main: margin/radius/border | side: bg/shadow | 结论 |
|---|---|---|---|---|
| 默认-亮 | oklch(1 0 0)（白，与 body 同） | 0px / 0px / 无边框（平铺） | 4px margin（panel card 保持） | ✅ 像素零变化 |
| 默认-暗 | oklch(0.25 0 0)（与 .dark bg 同） | 0px / 0px / 无边框（平铺） | 4px margin（panel card 保持） | ✅ 像素零变化 |
| Linear-亮 | oklch(0.962 0.003 260)（浅灰） | 8px / 14px / 1px solid oklch(0.90) | transparent, shadow:none, margin:0 | ✅ 符合设计 |
| Linear-暗 | oklch(0.13 0.003 260)（近黑） | 8px / 14px / 1px solid oklch(0.26) | transparent, shadow:none, margin:0 | ✅ 符合设计 |

---

## 开放风险

1. **WindowTitleBar（Windows）**：`app-titlebar` 类已追加，覆盖规则已写入 globals.css，但实施者使用 macOS，无法实机验证 Windows Tauri 打包态的标题栏渲染。代码路径正确（`WindowTitleBar` 组件、`data-platform="windows"` 样式均验证逻辑无误）。
2. **持久化首帧 no-flash**：内联脚本依赖 `suppressHydrationWarning` 豁免 `<html>` 上 SSR/client 的 `data-style` 不一致。已有 `suppressHydrationWarning` 属性（`app/layout.tsx:57`），`preview_console_logs` 未观察到 hydration 警告来自 `<html>` 元素。
3. **既有 hydration 警告**：`AppearanceSettings` 中已有的「主题」三按钮存在 pre-existing hydration mismatch（`useTheme()` 在 SSR 返回 undefined，客户端读到实际 theme 后不匹配），非本次引入。本次新增的「界面风格」两按钮用 `useState("default")` + `useEffect` 回避了同类问题。
4. **`--background` 连锁**：暗色 Linear 把 `--background` 重定义为主卡面色后，`body.bg-background`（layout.tsx）与 skip-link `focus:bg-background` 会跟随——spec 已知并接受，实视觉走查无异常。
5. **chat 页面内 `bg-background`**：暗色 Linear 下约 7 处 `bg-background` 用法与主卡同色，spec 明确为"期望行为"；chat 页面视觉走查无白块/黑块。
