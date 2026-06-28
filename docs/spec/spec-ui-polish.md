# UI Polish Spec：图标统一、日夜模式一致性、Confirm/Toast 体系、动效收口

**版本**: v1.0
**日期**: 2026-06-07
**作者**: UI/UX review (ui-ux-pro-max)
**状态**: 待执行
**前置**: 无；与 `spec-arch-hardening.md` 互不冲突

---

## 0. 调研结论

| 维度 | 现状 | 评估 |
|---|---|---|
| 图标库 | `lucide-react` 已在 `app-nav.tsx` 用 | 已有标准，但**未铺开**——knowledge/preview 还有 emoji |
| 暗色模式 | `next-themes` + `data-theme="dark"` 接好，`tokens.css` 双套色 | 基础到位，**有重复定义**和**对比度死角** |
| 动效 | `motion`(framer) 12.40 已装 | **零用**——只有 CSS transitions，icon/页面级动效缺位 |
| Confirm | `.confirm-dialog` CSS 类 | **没组件化**，3 处手写 HTML；CSS 在 shell + utilities 重复 |
| Toast | 无 | `chat-page.tsx:374` 直接 `alert()` |
| 图标尺寸 | 全部硬编码 `size={14}` 类 | tokens.css 有 `--icon-sm/md/lg` 但**未使用** |

## 1. 引入的新依赖

| 包 | 用途 | 替代方案 | 体积 |
|---|---|---|---|
| `sonner` | Toast 通知（替 `alert()`，destructive 操作反馈、成功提示） | 自写 | ~5KB |
| `@radix-ui/react-alert-dialog` | 可访问的 confirm 对话框（替散落 `.confirm-dialog` 手写 HTML） | 自写 + focus trap 自管 | ~12KB |
| `cmdk` (可选) | 命令面板（`⌘K` 跳转/触发技能/搜索知识库） | 不做 | ~8KB |
| `@lottiefiles/dotlottie-react` | 仅 3 处复杂动画图标：上传成功、Agent 思考、空状态 | 用 lucide + motion 也可 | ~30KB (lazy load) |

**不引入** Tailwind、shadcn、icon kit 之类大改造；保持现有 CSS 变量系统。

---

## WP1：清理 emoji，统一 lucide

### 现状

| 文件:行 | emoji | 用途 |
|---|---|---|
| `app/knowledge/page.tsx:221` | 🔍 | 搜索框图标 |
| `app/knowledge/page.tsx:302` | 📄 | 文档卡片图标 |
| `app/knowledge/page.tsx:309` | 🗑 | 删除按钮 |

### 改法

| 替换 | Lucide 组件 | 尺寸 token |
|---|---|---|
| 🔍 | `Search` | `--icon-sm` (15px) |
| 📄 | `FileText` / `FileSpreadsheet` / `FileSearch`（按 `doc.mimeType` 路由） | `--icon-md` (17px) |
| 🗑 | `Trash2` | `--icon-sm` |

文档卡片图标按 mimeType 分发：
- pdf → `FileText`（红色 wash）
- xlsx/csv → `FileSpreadsheet`（绿色 wash）
- docx → `FileType`（蓝色 wash）
- pptx → `Presentation`
- 其他 → `File`

颜色用 `--success-wash / --danger-wash / --accent-wash` 做角标背景，stroke 用 `currentColor` 继承父级，自动跟随主题。

### 不动

`app/icons/*.svg` 文件级 mime 图标（`csv.svg`, `pdf.svg` 等）属于**附件预览缩略图**，是品牌化彩色 SVG，**保留**。Lucide 仅替换 UI 元素中的 emoji。

---

## WP2：统一 icon size token

### 现状

`tokens.css:195-197` 已定义：
```css
--icon-sm: 15px;
--icon-md: 17px;
--icon-lg: 20px;
```

但**没人用**——`app-nav.tsx:111` `<EllipsisVertical size={14} />`、`tool-call-pill.tsx` 等全是裸数字。

### 改法

新增 `app/shared/icon.tsx`：

```tsx
import type { LucideIcon, LucideProps } from "lucide-react";

type Size = "sm" | "md" | "lg";
const sizeMap: Record<Size, string> = {
  sm: "var(--icon-sm)",
  md: "var(--icon-md)",
  lg: "var(--icon-lg)",
};

export function Icon({
  as: Cmp,
  size = "md",
  ...rest
}: { as: LucideIcon; size?: Size } & Omit<LucideProps, "size">) {
  return <Cmp size={sizeMap[size]} aria-hidden="true" {...rest} />;
}
```

使用：

```tsx
<Icon as={Settings} size="md" />
```

lucide 接受 string size，可直接传 CSS var。

### 验收

- [ ] `grep -E "size=\{[0-9]+\}" app --include="*.tsx"` 命中数 = 0（仅图标方面）
- [ ] 改 `--icon-md` 为 19px，所有中型图标同步变大

---

## WP3：日夜模式 token 清理与对比度修复

### 现状问题

1. **`tokens.css:3-67` 与 `:root :120-258` 重复定义**——后者覆盖前者，前者死代码
2. **暗色模式下的 wash 色** `--blue-soft: #0d2845` 不透明，跟 `--surface: #1a1e25` 对比度 ≈ 1.4:1，作为 chip 背景**几乎看不见**
3. **`--todo-urgent-bg / --todo-done-bg` 在 dark 下设为 `transparent`** → 标签退化成纯文字，丢了视觉编码（违反 `color-not-only` 准则）
4. **`--text-3` 暗色 `#6b7280` 对 `--surface` `#1a1e25` 仅 4.2:1**——刚过 AA normal 文本，但当 caption(12px) 不达标（应 ≥ 4.5:1）
5. **图标 stroke 没显式设主题**——lucide 用 `currentColor`，但很多 `.recent-menu-btn` 这类按钮**没设 `color`**，吃父级；暗色下偶发对比度漂移

### 改法

#### WP3.1 删重复

删 `tokens.css:3-67` 整段旧 light 定义（行 1-67），保留 `120-258` 作为唯一 light source；`69-116` 旧 dark 块同样删掉，保留 `260-370` 作为唯一 dark。提交前 `grep -n "^:root\|^\[data-theme" app/styles/tokens.css` 应只剩 2 行（一个 `:root` + 一个 `[data-theme="dark"]`）。

#### WP3.2 对比度修复

| Token | 当前（dark） | 改为 | 与 `--surface` 对比度 |
|---|---|---|---|
| `--text-3` | `#6b7280` | `#8a93a3` | 4.6:1（AA normal pass） |
| `--blue-soft` | `rgba(1,105,204,0.18)` | `rgba(49,131,216,0.22)` | chip 可见 |
| `--todo-urgent-bg` (dark) | `transparent` | `rgba(245,158,11,0.14)` | 保留视觉编码 |
| `--todo-done-bg` (dark) | `transparent` | `rgba(34,197,94,0.14)` | 同上 |

加自动化测试 `tests/contrast.test.ts`：解析 `tokens.css`，对 `text / text-2 / text-3 vs bg / surface / surface-2` 9 组配对，用 [APCA 或 WCAG 公式](https://www.w3.org/TR/WCAG21/#contrast-minimum) 断言 ≥ 4.5。

#### WP3.3 状态层一致性

新增 token：

```css
:root {
  --state-hover-light: rgba(15, 15, 14, 0.04);
  --state-press-light: rgba(15, 15, 14, 0.08);
  --state-focus-ring: var(--accent-ring);
}
[data-theme="dark"] {
  --state-hover-light: rgba(255, 255, 255, 0.05);
  --state-press-light: rgba(255, 255, 255, 0.10);
}
```

所有按钮的 `:hover / :active` 改用 `--state-hover-light / --state-press-light`，废弃 `--cx-hover / --cx-hover-strong` 杂项。

### 验收

- [ ] 暗色下 chip / wash 元素眼测可辨
- [ ] `tests/contrast.test.ts` 全过
- [ ] `tokens.css` 行数 < 250（清理重复后）

---

## WP4：Confirm 对话框组件化

### 现状

`.confirm-dialog` 出现在 3 处：
- `app-nav.tsx:236`（删除对话）
- `config/knowledge/knowledge-settings.tsx`
- `knowledge/page.tsx`（删除文档，带 `role="dialog" aria-modal="true"`，**只有这处对**）

CSS 在 `shell.css:387` 和 `utilities.css:292` **重复定义**。

可访问性差：
- 两处没有 `role="dialog" aria-modal="true"`
- 没 focus trap（ESC 关闭、Tab 循环、初始 focus 到危险按钮的反面）
- 没 backdrop 点击关闭的统一处理

### 改法

#### WP4.1 引入 `@radix-ui/react-alert-dialog`

封装 `app/shared/confirm-dialog.tsx`：

```tsx
"use client";
import * as AlertDialog from "@radix-ui/react-alert-dialog";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({
  open, onOpenChange, title, description,
  confirmLabel = "确认", cancelLabel = "取消",
  destructive = false, onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="confirm-overlay" />
        <AlertDialog.Content className="confirm-dialog" data-destructive={destructive}>
          <AlertDialog.Title className="confirm-title">{title}</AlertDialog.Title>
          {description && <AlertDialog.Description className="confirm-desc">{description}</AlertDialog.Description>}
          <footer className="confirm-footer">
            <AlertDialog.Cancel asChild>
              <button className="ghost-action">{cancelLabel}</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button className={destructive ? "danger-action" : "primary-action"} onClick={onConfirm}>
                {confirmLabel}
              </button>
            </AlertDialog.Action>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
```

Radix 自动处理：
- `role="alertdialog"` + `aria-modal`
- focus trap、ESC 关闭、初始 focus 落到 Cancel（危险操作的安全默认）
- 屏幕阅读器朗读 title/description

#### WP4.2 CSS 收口

`utilities.css:292` 的 `.confirm-dialog` 整块删除，保留 `shell.css:387` 一份，且改名为 `[role="alertdialog"].confirm-dialog`（避免冲突）。新增 `.confirm-overlay`：

```css
.confirm-overlay {
  position: fixed; inset: 0;
  background: var(--modal-backdrop-bg);
  backdrop-filter: blur(2px);
  animation: confirm-overlay-in 150ms ease-out;
}
.confirm-dialog {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100% - 48px));
  /* 原有样式保留 */
  animation: confirm-dialog-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes confirm-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes confirm-dialog-in {
  from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .confirm-overlay, .confirm-dialog { animation: none; }
}
```

`data-destructive="true"` 时 confirm 按钮自动变红，遵守 `destructive-emphasis` 准则。

#### WP4.3 替换 3 处调用点

- `app-nav.tsx`：`renderDeletePortal()` 整段删，改成 `<ConfirmDialog open={!!deleteTarget} title="删除会话" description={...} destructive onConfirm={confirmDelete} />`
- `knowledge/page.tsx`：同上
- `config/knowledge/knowledge-settings.tsx`：同上

### 验收

- [ ] 3 处 `<section className="confirm-dialog">` 全部消除
- [ ] `.confirm-dialog` CSS 只出现在 1 个文件
- [ ] ESC、Tab、初始 focus、屏幕阅读器朗读全过
- [ ] dark + light 视觉一致

---

## WP5：Toast 通知体系

### 现状

`chat-page.tsx:374` `alert("文件超过 50MB 限制")`——native alert 阻塞、丑、移动端不可控、暗色模式不适配。

### 改法

#### WP5.1 引入 sonner

`app/layout.tsx` 顶层挂 `<Toaster />`：

```tsx
import { Toaster } from "sonner";

// 在 <body> 内 children 之后：
<Toaster
  position="bottom-right"
  theme="system"
  toastOptions={{
    classNames: {
      toast: "app-toast",
      success: "app-toast-success",
      error: "app-toast-error",
    },
  }}
/>
```

sonner 自带 `theme="system"`，会跟 `prefers-color-scheme` 走；如果用户在设置里强切主题，传 `theme={resolvedTheme}`（在 `theme-provider.tsx` 里包一层）。

#### WP5.2 替换 alert + 加成功反馈

- `chat-page.tsx:374` `alert(...)` → `toast.error("文件超过 50MB 限制", { description: file.name })`
- 删除会话/文档**成功后**：`toast.success("已删除", { action: { label: "撤销", onClick: ... } })` —— 满足 `undo-support` 准则
- 报销校验完成、金蝶草稿导出完成：`toast.success(...)` 替代当前"AI 文本里说一声"

#### WP5.3 样式接 token

```css
.app-toast {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}
.app-toast-success { border-left: 3px solid var(--success); }
.app-toast-error   { border-left: 3px solid var(--danger); }
```

### 验收

- [ ] `grep -rn "alert(" app --include="*.tsx"` = 0
- [ ] 暗色下 toast 不发白
- [ ] 删除操作支持 5 秒内撤销

---

## WP6：按钮三态语义化 + 触摸目标

### 现状

按钮种类杂：`.ghost-action`, `.danger-action`, `.primary-action`, `.recent-menu-btn`, `.app-brand`, 各种内联 className。三态（hover/active/disabled）不一致：
- 部分按钮无 disabled 视觉（如 `app-nav.tsx:111` 的 `EllipsisVertical`）
- focus ring 不统一（部分依赖浏览器默认 outline）
- 触摸目标小于 44×44，如 `recent-menu-btn` 视觉 ~24px

### 改法

#### WP6.1 增加全局按钮基类

`primitives.css` 加：

```css
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 32px; min-width: 32px;
  padding: 6px 12px;
  border-radius: var(--radius);
  font: inherit; font-size: var(--font-ui);
  cursor: pointer;
  transition: background 120ms ease, transform 80ms ease, box-shadow 150ms ease;
  /* 触摸目标扩展：视觉 32px，hit area 44px */
  position: relative;
}
.btn::before {
  content: ""; position: absolute; inset: -6px;
  /* 透明扩展层，仅 pointer 命中 */
}
.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-ring);
}
.btn:active:not(:disabled) { transform: scale(0.97); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary {
  background: var(--accent); color: var(--accent-fg);
}
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-ghost {
  background: transparent; color: var(--text-2);
  border: 1px solid var(--border);
}
.btn-ghost:hover:not(:disabled) { background: var(--state-hover-light); }
.btn-danger {
  background: var(--danger); color: var(--accent-fg);
}
.btn-icon-only { padding: 6px; min-width: 32px; }

@media (prefers-reduced-motion: reduce) {
  .btn:active:not(:disabled) { transform: none; }
}
```

#### WP6.2 重命名旧类（向后兼容）

`.ghost-action → .btn.btn-ghost`、`.danger-action → .btn.btn-danger`、`.primary-action → .btn.btn-primary`。改 className 一次，全文件搜替。

#### WP6.3 图标按钮的 aria

所有只显示图标的按钮加 `aria-label`。`app-nav.tsx:106` 已经有，其他位点检查：`tool-call-pill.tsx`, `chat-file-panel.tsx`, `file-preview-page.tsx`。

### 验收

- [ ] 键盘 Tab 一圈，所有按钮 focus ring 一致（蓝色 2px 双层 ring）
- [ ] 移动端 touch hit area ≥ 44×44（通过 `::before` 扩展）
- [ ] axe-core 跑 chat / cockpit / knowledge 三页，按钮相关 violation = 0

---

## WP7：卡片层级与暗色阴影

### 现状

卡片散用 `.card`, `.stat-card`, `.overview-card`, `.recent-item`, `.doc-card`，shadow 用 `var(--shadow)`，但暗色下 shadow `rgba(0,0,0,0.24)` 在 `#13161b` 背景上**几乎看不到**——丢了层级。

### 改法

#### WP7.1 暗色用 elevation = 边框 + 微亮上沿

暗色模式 card 改用：

```css
[data-theme="dark"] .card,
[data-theme="dark"] .stat-card,
[data-theme="dark"] .overview-card {
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow);
}
```

`inset 0 1px 0` 是一道顶部高光，模拟 Material 的 "elevation tint"，在深色下立刻把卡片"抬"起来。

#### WP7.2 统一卡片 token

```css
:root {
  --card-bg: var(--surface);
  --card-border: var(--border);
  --card-shadow: var(--shadow);
  --card-radius: var(--radius-lg);
}
[data-theme="dark"] {
  --card-shadow: inset 0 1px 0 rgba(255,255,255,0.04), var(--shadow);
}
.card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); box-shadow: var(--card-shadow); }
```

废弃 `.stat-card`、`.overview-card` 等自定义 shadow/border，统一继承 `.card`。

#### WP7.3 hover 抬升

```css
.card[data-interactive="true"]:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-lg);
  transition: transform 150ms ease, box-shadow 150ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .card[data-interactive="true"]:hover { transform: none; }
}
```

仅对**可点击**卡片加 `data-interactive="true"`（如 cockpit 的 recent activity 行），避免装饰性 hover。

### 验收

- [ ] 暗色下任意页面卡片可辨别于背景
- [ ] light/dark 切换无闪烁（已有 `disableTransitionOnChange`）

---

## WP8：图标动效（lucide + framer-motion）

### 原则

motion 仅用于**有意义**的动画（符合 `motion-meaning` 准则），不做装饰性。3 类合适场景：

| 场景 | 图标 | 动画 |
|---|---|---|
| 主题切换按钮 | `Sun ↔ Moon` (lucide) | 旋转 180° + 淡入淡出，duration 220ms |
| Agent 思考中 | `Loader2` | 自定义 360°旋转，spring 1.2s 循环；或换 lottie |
| 工具调用步进 | `Check / X` | scale 0.6 → 1.0 spring，press 反馈 |
| 删除/危险按钮 hover | `Trash2` | 抖动 ±2° 100ms（一次） |
| 复制成功 | `Copy → Check` 200ms 跨形态 | 字形 morph |
| 收起/展开（nav） | `ChevronDown` | 旋转 90°（已有 CSS 实现可保留） |

### 实现

#### WP8.1 `app/shared/animated-icon.tsx`

```tsx
"use client";
import { motion, type Variants } from "motion/react";
import type { LucideIcon } from "lucide-react";

const presets = {
  spin: { animate: { rotate: 360 }, transition: { duration: 1.2, repeat: Infinity, ease: "linear" } },
  press: { whileTap: { scale: 0.85 }, whileHover: { scale: 1.05 } },
  shake: { whileHover: { rotate: [0, -3, 3, -3, 0] }, transition: { duration: 0.3 } },
} as const;

export function AnimatedIcon({
  as: Cmp, preset, size = "var(--icon-md)", ...rest
}: { as: LucideIcon; preset: keyof typeof presets; size?: string } & React.ComponentProps<typeof motion.span>) {
  return (
    <motion.span style={{ display: "inline-flex" }} {...presets[preset]} {...rest}>
      <Cmp size={size} aria-hidden="true" />
    </motion.span>
  );
}
```

#### WP8.2 主题切换（替换静态图标）

`app/config/appearance/appearance-settings.tsx` 当前主题切换按钮静态 ☀/🌙——改成：

```tsx
import { AnimatePresence, motion } from "motion/react";
import { Sun, Moon } from "lucide-react";

<button className="btn btn-ghost btn-icon-only" onClick={toggleTheme} aria-label="切换主题">
  <AnimatePresence mode="wait" initial={false}>
    <motion.span
      key={resolvedTheme}
      initial={{ rotate: -90, opacity: 0 }}
      animate={{ rotate: 0, opacity: 1 }}
      exit={{ rotate: 90, opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      style={{ display: "inline-flex" }}
    >
      {resolvedTheme === "dark" ? <Moon size="var(--icon-md)" /> : <Sun size="var(--icon-md)" />}
    </motion.span>
  </AnimatePresence>
</button>
```

#### WP8.3 Agent 思考态（替静态 loader）

`chat-message.tsx` 工具调用 pending 状态用 `<AnimatedIcon as={Loader2} preset="spin" />` 取代当前 CSS spinner（如果有）。

#### WP8.4 Reduced-motion 兜底

`animated-icon.tsx` 内部读 `useReducedMotion()`（framer 提供），命中时**所有 preset 退化为静态**——无需每个调用点判断。

#### WP8.5 复杂动效（可选）：Lottie 仅 3 处

- 空状态插画（cockpit "暂无活动"、knowledge "暂无文档"）
- 上传成功庆祝
- "Agent 正在思考"的呼吸式动效

资源放 `public/lottie/*.lottie`，用 `@lottiefiles/dotlottie-react` 懒加载。**不强制**，框架可后接。

### 验收

- [ ] 切主题按钮有自然旋转过渡，暗色/亮色图标无生硬替换
- [ ] `prefers-reduced-motion: reduce` 时所有 motion 退化
- [ ] 工具调用 spinner 不依赖 CSS `@keyframes spin`，统一走 motion
- [ ] DevTools Performance 录制：动画 GPU 合成，无 layout reflow（动 transform/opacity）

---

## WP9：命令面板（可选增强）

### 动机

财务用户高频在「报销校验」「薪税计算」「知识库搜索」之间切换。当前唯一入口是侧边栏点击，4 级菜单。命令面板（`⌘K`）能让所有功能在 200ms 内可达。

### 实现

引入 `cmdk`，新建 `app/shared/command-palette.tsx`：

- 全局键盘快捷 `⌘K / Ctrl+K` 打开
- 索引：所有路由（cockpit/chat/knowledge/settings）+ 5 个 skill + 最近 10 个会话
- 输入跨字段 fuzzy 搜索
- ESC 关闭、↑↓ 选择、Enter 触发

样式接现有 token，dark/light 自适应。

### 验收

- [ ] `⌘K` 任意页面打开
- [ ] 输入"报销"高亮"报销校验"skill 入口
- [ ] focus 不丢失，ESC 还原

### 不做

不做协同/分享/多用户相关命令；保持单机定位。

---

## WP10：可访问性回归测试

### 工具

引入 `@axe-core/react`（dev only）+ 一个最小 `tests/a11y.test.ts`（happy-dom 渲染各页面调 `axe()`，断言 violations = 0）。

### 范围

每页跑：
- cockpit
- chat（空态 + 有消息态）
- knowledge（空态 + 有文档态）
- settings
- file-preview

每页要点：
- 所有 button 有 aria-label 或可见文字
- form input 有关联 label
- alert/dialog 有 role 与 aria-modal
- color 对比度（用 token contrast 测试覆盖，不重复）

---

## 执行顺序

| 阶段 | WP | 估时 | 依赖 |
|---|---|---|---|
| **A** 立刻可做、独立 | WP1 (emoji), WP2 (icon size), WP3 (token 清理) | 1 天 | 无 |
| **B** 组件化 | WP4 (confirm), WP5 (toast), WP6 (button) | 1.5 天 | A |
| **C** 视觉打磨 | WP7 (card elevation), WP8 (icon motion) | 1 天 | B |
| **D** 增强（可选） | WP9 (cmdk), WP10 (a11y test) | 1 天 | C |

总计 ~3.5 天（不含 D ~4.5 天）。

---

## 退路 / 风险

| WP | 风险 | 缓解 |
|---|---|---|
| WP1 | mimeType 路由覆盖不全 | 默认 `File` 兜底 |
| WP3 | 删旧 token 块漏改引用 | 删之前 `grep -r "var(--cx-hover-strong)"` 等老 token，先迁移再删 |
| WP4 | Radix portal 与 Tauri webview z-index 冲突 | 已有 `--popover-shadow / modal-backdrop-bg` token，portal 默认到 body，无冲突；如有用 Radix `container` prop 指定 |
| WP5 | sonner 主题 prop 闪烁 | 用 `useTheme().resolvedTheme` 控制，避免 SSR 错配 |
| WP8 | motion 12 与 framer-motion 11 API 差异 | 项目装的是 `motion@12.40`（新包名），import 走 `motion/react`，文档已迁移 |
| WP9 | 全局 `⌘K` 与浏览器/IME 冲突 | 监听阶段 `keydown` 且检查 `e.metaKey + e.key === "k"`，且 input 焦点内允许默认 |

---

## 不做（明确划界）

- 不重写设计系统（不引 shadcn / tailwind）——保留现有 CSS var + 模块化 CSS
- 不替换图标库——lucide 已经够用
- 不做移动端响应式重构——Tauri 桌面单分辨率为主
- 不做 i18n 文案抽取——当前中文硬编码可接受
- 不做品牌系统升级——只做现有视觉的一致性与可访问性
