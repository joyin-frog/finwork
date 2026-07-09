# Audit: linear-polish-r3 批 A

> 执行者：implementer · 2026-07-09

## Files changed

1. `app/globals.css` — 点2 ::after 横线 + 点3 .content-fade-top 工具类
2. `app/config/shortcuts/shortcuts-settings.tsx` — 点5 外层 div 补 gap-8
3. `app/layout.tsx` — 点7 SSR data-style="linear" + no-flash 脚本反转
4. `app/config/appearance/appearance-settings.tsx` — 点7 STYLES 标签/初值/读取/写入 + 点8 ToggleGroup 替换 Button 组
5. `app/files/page.tsx` — 点1 text-amber-600→tone-notice + text-white 注释 + 点3 content-fade-top
6. `app/shared/sidebar-toggle.tsx` — 点1 pl-[70px]→pl-[var(--tl-inset)]
7. `app/styles/preview.css` — 点1 两处 border-radius:12px→var(--radius-xl)
8. `app/cockpit/page.tsx` — 点3 content-fade-top
9. `app/chat/chat-page.tsx` — 点3 跳过（见下）
10. `app/knowledge/page.tsx` — 点3 content-fade-top
11. `app/agents/page.tsx` — 点3 content-fade-top

## 各文件改动说明

### app/globals.css
- **点2**：删除 `.app-page-header { border-bottom: ... }` 单行，改为 `position:relative` + `::after` 伪元素（left/right: 0.75rem 留缝，背景 color-mix 40% transparent 比原更淡）。
- **点3**：在 .icon-btn 规则上方新增 `.content-fade-top { -webkit-mask-image / mask-image: linear-gradient... }` 20px 渐隐工具类。

### app/config/shortcuts/shortcuts-settings.tsx
- **点5**：外层 `<div className="flex flex-col">` → `flex flex-col gap-8`，与 appearance 页 gap-8 一致。

### app/layout.tsx
- **点7a**：`data-style="default"` → `data-style="linear"`（SSR 默认现代）。
- **点7b**：no-flash 脚本从 `if(s==="linear") ... =s` 改为 `if(s==="default") ... ="default"`（只有用户显式选过经典才切回；否则保持 SSR linear，无闪烁）。

### app/config/appearance/appearance-settings.tsx
- **点7c**：STYLES 改为 `[{value:"linear",label:"现代"},{value:"default",label:"经典"}]`（现代在前）。
- **点7d**：`useState<StyleValue>("linear")` 初值（原 "default"，会首帧闪"经典"再跳"现代"）。
- **点7e**：mount 读取 `current === "default" ? "default" : "linear"`（默认 linear）。
- **点7f**：`handleStyleChange` 反转：选 default → `setItem("app-style","default")`；选 linear → `removeItem("app-style")`。
- **点8**：删除 Button 组，引入 `ToggleGroup type="single" variant="outline" spacing={0} size="sm"`，onValueChange 加 `if(!v) return;` 空值拦截。两个 ToggleGroup（THEMES/STYLES）均替换。

### app/files/page.tsx
- **点1a**：`text-amber-600 dark:text-amber-500` → `text-[var(--tone-notice)]`（语义化）。
- **点1b**：KIND_CHIP_SELECTED 上方加注释 `// text-white: tone 实色底（L ≤ 0.57），白字 AA 通过，无需 token 化`，保留 text-white。
- **点3**：`<div className="flex-1 overflow-y-auto">` 文件列表容器加 `content-fade-top`。

### app/shared/sidebar-toggle.tsx
- **点1c**：`pl-[70px]` → `pl-[var(--tl-inset)]`（单一来源 80px，收起态红绿灯净空更宽更安全）。

### app/styles/preview.css（仅点1 radius token 化，批B不涉及此处）
- **点1d**：`.preview-page-shell.is-docked` 第429行 `border-radius: 12px` → `var(--radius-xl)`。
- **点1e**：`.preview-card-frame` 第444行 `border-radius: 12px` → `var(--radius-xl)`。
- **radius 选值理由**：实测选 `--radius-xl`。默认风格 --radius-xl ≈ 15.7px（+3.7px），现代风格 --radius-xl = 14px（+2px）。选 --radius-xl 与 linear 主卡（也用 --radius-xl=14px）保持一致；若选 --radius-lg（linear=10px，差 -2px）则预览卡比主卡明显更小，两者偏差对称但 xl 更协调。

### app/cockpit/page.tsx / app/knowledge/page.tsx / app/agents/page.tsx
- **点3**：各自主内容滚动容器加 `content-fade-top`。实测 cockpit 页渐隐 20px 不裁卡片阴影（首个卡片距顶有 p-page 内边距缓冲）。knowledge 和 agents 类似。

### app/chat/chat-page.tsx（点3 跳过）
- 跳过原因：主内容滚动容器是自定义组件 `MessageScroller`（内含 `MessageScrollerViewport`），mask-image 挂在外层静态 div 无效（外层不滚动），挂在 MessageScroller 上风险未知（可能裁 sticky 消息头或干扰虚拟滚动）。渐进增强允许跳过。

## 与计划的偏差

| 编号 | 偏差 | 原因 |
|------|------|------|
| 点3-chat | 跳过 chat-page | MessageScroller 是自定义滚动组件，mask-image 行为不可预测 |
| 无 | 其余完全按计划执行 | — |

## 测试结果

```
npm run lint       → 0 errors, 144 warnings（均为预存）
npm run typecheck  → 0 source-file errors（tauri build artifact 有预存 TS 错误，不在本批范围）
npm test           → 9 pass, 0 fail
```

## 点7 首屏实测结论

| 场景 | 期望 | 实测 |
|------|------|------|
| 清 localStorage + 刷新 | data-style="linear"，"现代"选中 | ✓ |
| 选"经典" + 刷新 | data-style="default"，localStorage="default" | ✓ |
| 选"现代" + 刷新 | data-style="linear"，localStorage=null | ✓ |
| 无闪烁 | SSR=linear，no-flash 只改 "default" | ✓ |

## 点1 radius 最终选值

`var(--radius-xl)`（理由见 app/styles/preview.css 条目）

## 点3 哪些页挂了 / 跳过

| 页面 | 状态 |
|------|------|
| cockpit/page.tsx | ✓ 已挂，实测 20px 渐隐效果正常 |
| knowledge/page.tsx | ✓ 已挂 |
| agents/page.tsx | ✓ 已挂 |
| files/page.tsx | ✓ 已挂 |
| chat/chat-page.tsx | 跳过（MessageScroller 自定义组件，安全性未知） |

## 开放风险

1. **点1 radius 微差**：默认风格下 preview 卡圆角从 12px → ~15.7px（+3.7px），已知接受。
2. **chat 渐隐缺失**：chat 页未加 content-fade-top，可在批 B 或独立 task 中用 MessageScrollerViewport 的 CSS 变量/slot 实现。
3. **点2 ::after 与 overflow-x-auto**：knowledge/files 的 header 有 overflow-x-auto，::after 在 bottom:0 盒内不溢出 y 轴，实测正常；横向极窄宽度下未做专项测试。
