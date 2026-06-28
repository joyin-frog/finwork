# Spec：评估弱项修复

**版本**: v1.0
**日期**: 2026-06-07
**来源**: 项目评估报告弱项清单
**估时**: 3h

---

## WP1：CSS Token 旧系统清理（`--cx-*` → 标准 token）

### 现状

`utilities.css` 仍有 ~15 处 `--cx-*` 旧 token 引用：
- `--cx-text-muted` → 应改为 `--text-2`
- `--cx-text-heading` → 应改为 `--text`
- `--cx-text-soft` → 应改为 `--text-2`
- `--cx-text-subtle` → 应改为 `--text-3`
- `--cx-surface` → 应改为 `--surface`
- `--cx-border` → 应改为 `--border`
- `--cx-hover-strong` → 应改为 `--surface-hover`
- `--cx-bg` → 应改为 `--bg`

### 改法

逐文件 grep `--cx-` 替换，提交前 `grep -rn "\-\-cx-" app/styles` = 0。

---

## WP2：Inline Style → CSS class 收口

### 现状

`chat-page.tsx` 中有多段 inline style：
```tsx
style={{ display: "flex", flexDirection: "column", gap: "8px" }}
```

### 改法

- 新增 `.vstack` / `.hstack` 工具类到 `utilities.css`
- 替换所有 `display:flex; flex-direction:column; gap` 的 inline style
- 保留确实需要动态值（如 width、color）的 inline style

---

## WP3：暗色模式 accent 对比度修复

### 现状

`tokens.css` dark mode: `--accent: #0169cc`，在 `--bg: #13161b` 上对比度 ~1.5:1，肉眼几乎不可见。

影响范围：active nav icon、链接色、primary button 文字。

### 改法

`tokens.css` dark mode：
```css
--accent: #4a9aeb;  /* was #0169cc, 亮度提升 ~40% */
--accent-hover: #6ab0f0;
```

保持 `--accent-wash` 和 `--accent-ring` 同步更新。

---

## WP4：设置面板与主内容区视觉统一

### 现状

设置页 (`config/page.tsx`) 使用 `settings-float.css` 浮动窗口风格（backdrop blur + glow + 独立卡片），与 cockpit/chat/knowledge 的直接嵌入风格不一致。

### 改法

不搞大重构。最小改动：
- 设置面板背景从 `rgba(255,255,255,0.96)` 改为 `var(--surface)`
- 移除 backdrop-filter 大 glow
- 统一 section title 字号/字重与 cockpit 一致
- 保持 tab 切换和设置项布局不变

---

## WP5：知识库搜索/上传区域 spacing

### 现状

`knowledge-page.css` 中 search bar 和 upload zone 之间的 gap 偏紧（~10px），视觉拥挤。

### 改法

- `.knowledge-search-bar` margin-bottom: 8px → 14px
- `.knowledge-upload-zone` padding: 12px → 16px
- 搜索框高度 34px → 38px，匹配 touch target

---

## WP6：聊天文件面板与主内容区视觉分隔

### 现状

右侧文件面板 `chat-file-panel` 与消息区域之间仅有 1px border，内容密集时难以区分。

### 改法

- 左边框从 `1px solid var(--border)` → `1px solid var(--border)` + 左侧添加 4px padding
- 面板背景从透明 → `var(--surface-2)`（微妙区分）

---

## WP7：组件级单元测试

### 范围

给可独立测试的纯展示组件补测试：
- `MetricCard` 四种 variant 渲染
- `ConfirmDialog` open/close 状态
- `AnimatedNumber` 数值显示

### 不改

不补交互测试、不补 e2e、不补 a11y 自动检测——这些属于可选增强，不在本次范围。

---

## 执行顺序

| 顺序 | WP | 估时 |
|---|---|---|
| 1 | WP1: CSS token 清理 | 30 min |
| 2 | WP2: inline style 收口 | 30 min |
| 3 | WP3: accent 对比度 | 15 min |
| 4 | WP4: 设置面板统一 | 30 min |
| 5 | WP5: 知识库 spacing | 15 min |
| 6 | WP6: 文件面板分隔 | 15 min |
| 7 | WP7: 组件测试 | 45 min |

总计 ~3h
