# Motion 专项 Spec：动效落点清单与实现

**版本**: v1.0
**日期**: 2026-06-07
**作者**: UI/UX review
**状态**: 待执行
**前置**: `spec-ui-polish.md`（共用 WP8 的 `<AnimatedIcon>` 抽象、reduced-motion 兜底）
**依赖**: `motion@12.40.0`（已装）

---

## 0. 总原则

| 原则 | 说明 |
|---|---|
| Motion has meaning | 每段动效要有"因果关系"：状态变化、空间连续、注意力引导。装饰性弹跳不做。 |
| Exit faster than enter | 退出动画用进入的 60-70%（如 enter 220ms → exit 150ms）。 |
| Transform/opacity only | 不动 `width/height/top/left`；用 `transform` 和 `opacity`，必要时 `layout` prop（motion 帮你做 FLIP）。 |
| Spring 优先 | UI 体感优于精确曲线；`type: "spring", stiffness: 260, damping: 24` 是默认。 |
| Reduced-motion | 全局 `useReducedMotion()` 命中后退化为 fade-only 或瞬切。 |
| 一处定义 variants | `app/shared/motion-presets.ts` 集中维护，避免散落硬编码。 |

### 全局 presets

`app/shared/motion-presets.ts`：

```ts
import type { Variants, Transition } from "motion/react";

export const SPRING_DEFAULT: Transition = { type: "spring", stiffness: 260, damping: 24, mass: 0.7 };
export const EASE_OUT_QUICK: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] };
export const EASE_OUT_QUICK_EXIT: Transition = { duration: 0.12, ease: [0.4, 0, 1, 1] };

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: EASE_OUT_QUICK },
  exit: { opacity: 0, transition: EASE_OUT_QUICK_EXIT },
};

export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: SPRING_DEFAULT },
  exit: { opacity: 0, scale: 0.98, y: 2, transition: EASE_OUT_QUICK_EXIT },
};

export const slideUpIn: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: SPRING_DEFAULT },
  exit: { opacity: 0, y: -4, transition: EASE_OUT_QUICK_EXIT },
};

export const listContainer: Variants = {
  hidden: { transition: { staggerChildren: 0.02, staggerDirection: -1 } },
  visible: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};
```

---

## WP-M1：工具调用步进展开（高 ROI）

### 现状

`app/components/tool-call-step.tsx:53-78`：

```tsx
{expanded && hasDetail && (
  <div className="tool-step-detail">...</div>
)}
```

硬切换。用户最高频交互（每条 assistant 消息可能有 3-10 个 step），平滑展开极大提升质感。

### 实现

```tsx
import { AnimatePresence, motion } from "motion/react";

<AnimatePresence initial={false}>
  {expanded && hasDetail && (
    <motion.div
      className="tool-step-detail"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ height: { duration: 0.22, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.18 } }}
      style={{ overflow: "hidden" }}
    >
      {/* 原内容 */}
    </motion.div>
  )}
</AnimatePresence>
```

ChevronDown 改用 `animate={{ rotate: expanded ? 180 : 0 }}`（已有 CSS class，但 motion 同步更可控）。

### 验收

- 连续展开/收起不出现高度抖动
- reduced-motion 下展开是瞬切（无 height animate）

---

## WP-M2：Thinking block 替代 `<details>`

### 现状

`chat-message.tsx:127` 用 `<details><summary>`，浏览器原生无动画。

### 实现

替成受控版本：

```tsx
import { AnimatePresence, motion } from "motion/react";

const [thinkOpen, setThinkOpen] = useState(...);

<div className="think-block">
  <button className="think-summary" onClick={() => setThinkOpen(v => !v)} aria-expanded={thinkOpen}>
    <span className="think-status">...</span>
    <motion.span animate={{ rotate: thinkOpen ? 180 : 0 }} transition={EASE_OUT_QUICK}>
      <ChevronDown size={14} />
    </motion.span>
  </button>
  <AnimatePresence initial={false}>
    {thinkOpen && (
      <motion.pre
        className="think-content"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ height: { duration: 0.24, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.2 } }}
        style={{ overflow: "hidden" }}
      >
        {thinking.done ? (thinkingEnd?.content ?? "") : thinking.content}
      </motion.pre>
    )}
  </AnimatePresence>
</div>
```

### 验收

- 展开时正在流式输入的内容（`thinking.content`）不被裁剪
- 长内容不卡顿（thinking 一般 < 5KB，OK）

---

## WP-M3：Nav active 指示器（layoutId 共享元素，杀手锏）

### 现状

`app-nav.tsx` 4 个一级 tab（总览/对话/知识库/设置）的 active 态靠 CSS `background-color`。切换页面是离散变化。

### 实现

```tsx
import { motion } from "motion/react";

{tabs.map((t) => (
  <Link key={t.key} href={t.href} className={`nav-tab${active === t.key ? " active" : ""}`}>
    {active === t.key && (
      <motion.span
        layoutId="nav-active-pill"
        className="nav-active-bg"
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
      />
    )}
    <Icon as={t.icon} size="md" />
    <span>{t.label}</span>
  </Link>
))}
```

CSS：

```css
.nav-tab { position: relative; }
.nav-active-bg {
  position: absolute; inset: 0; z-index: 0;
  background: var(--accent-wash);
  border-radius: var(--radius);
}
.nav-tab > * { position: relative; z-index: 1; }
```

效果：切换 tab 时背景"滑过去"而不是闪烁。一处 `layoutId="nav-active-pill"` 完成全部魔法。

### 验收

- 4 个 tab 间切换看到连续的滑动
- 折叠态（图标 only）仍然正确滑动
- reduced-motion 退化为直接切换（motion 内置支持）

### 风险

- 在 SSR 首屏可能闪一下：用 `layout="position"` 而非 `layout`，或加 `initial={false}`

---

## WP-M4：列表 stagger 入场

### 现状

cockpit 的 recent activity（`overview-card` 内 N 行）、knowledge 的 doc grid 首次加载/刷新是整块 pop-in，没有节奏感。

### 实现

外层加 `motion.div` 容器，内层每行 `motion.div` variants 用 `slideUpIn`：

```tsx
import { motion } from "motion/react";
import { listContainer, slideUpIn } from "@/app/shared/motion-presets";

<motion.ul className="activity-list" variants={listContainer} initial="hidden" animate="visible">
  {items.map((item) => (
    <motion.li key={item.id} variants={slideUpIn} className="activity-row">
      ...
    </motion.li>
  ))}
</motion.ul>
```

- 单行 enter ~180ms + spring
- 行间 stagger 35ms（符合 Material `stagger-sequence` 30-50ms）
- 8 行总耗时 ~280ms + 180ms = ~460ms，刚好不显得拖沓

### 应用位置

| 位置 | 文件 |
|---|---|
| Cockpit recent activity | `app/cockpit/page.tsx` |
| Cockpit top tools / latest ingest | 同上 |
| Knowledge doc grid | `app/knowledge/page.tsx` |
| 对话历史（recent panel） | `app/shared/app-nav.tsx` |
| Settings 内技能列表 | `app/config/skill-center.tsx` |

### 不做

- 聊天消息**不做**入场 stagger——文本流式渲染本身就是渐进的
- virtualized 列表（如果未来引入）不加 motion——row recycle 会冲突

---

## WP-M5：模态体系（confirm / popover / sheet）

### 整合点

`spec-ui-polish.md` 的 WP4 用了 Radix + CSS keyframes。这里**改用 motion variants** 与其他 WP 统一：

```tsx
<AlertDialog.Overlay asChild>
  <motion.div variants={fadeIn} initial="hidden" animate="visible" exit="exit" className="confirm-overlay" />
</AlertDialog.Overlay>
<AlertDialog.Content asChild>
  <motion.div variants={popIn} initial="hidden" animate="visible" exit="exit" className="confirm-dialog">
    ...
  </motion.div>
</AlertDialog.Content>
```

Radix 配合 motion：用 `<AnimatePresence>` 包裹整个 `<AlertDialog.Root>` 内 children，并把 Radix 的 `forceMount` prop 打开（让 motion 控制挂载/卸载）。

### 其他模态

| 组件 | 现状 | 改造 |
|---|---|---|
| 删除 confirm（3 处） | CSS keyframes | popIn variants |
| AskUserQuestion 弹窗（agent hooks） | 未实现可视化 | 复用 popIn |
| 文件预览 Drawer（右侧栏） | 直接 mount | slide-in-right variants |
| Skill 配置 popover | 直接 mount | popIn |
| 上下文菜单（recent-menu-btn） | 直接 mount | popIn，origin 锚到点击源 |

`popover-bg / popover-shadow` token 已存在，沿用。

### 锚定动画（高级）

上下文菜单/skill popover 的 popIn 加 `style={{ transformOrigin: "top right" }}` 让缩放从触发按钮处展开，符合 `modal-motion` 准则（"动画从触发源开始"）。

---

## WP-M6：侧边栏 collapse

### 现状

`app-nav.tsx:118` `className={collapsed ? "app-nav collapsed" : "app-nav"}`。CSS width 切换瞬间。

### 实现

```tsx
<motion.aside
  className="app-nav"
  animate={{ width: collapsed ? 56 : 260 }}
  transition={SPRING_DEFAULT}
>
  ...
</motion.aside>
```

内部文字标签用 `<AnimatePresence>`：

```tsx
<AnimatePresence>
  {!collapsed && (
    <motion.span
      key="label"
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -4 }}
      transition={EASE_OUT_QUICK}
    >
      {label}
    </motion.span>
  )}
</AnimatePresence>
```

效果：图标位置稳定，文字"滑入/滑出"。

### 性能

`width` 属于 layout 属性，但侧边栏一次，且不嵌套 list，影响小。如果觉得卡，改用 `motion.div` 内层做 `x` translate，外层固定 260px 用 `clip-path`，但通常不需要。

### 验收

- 不撕裂主内容（中部 grid 用 `flex: 1`，跟随宽度变化）
- 折叠态 tooltip 立即生效

---

## WP-M7：Stat 数字 count-up（cockpit 四张卡）

### 现状

`cockpit/page.tsx` 顶部 4 个 stat card（待确认/今日对话/知识库/活跃技能）展示静态数字。从 0 跳到目标值无过程。

### 实现

新增 `app/shared/animated-number.tsx`：

```tsx
"use client";
import { useEffect } from "react";
import { animate, useMotionValue, useTransform, motion } from "motion/react";

export function AnimatedNumber({ value, duration = 0.9 }: { value: number; duration?: number }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    const controls = animate(mv, value, { duration, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [value, duration, mv]);
  return <motion.span>{rounded}</motion.span>;
}
```

用法：

```tsx
<div className="stat-value"><AnimatedNumber value={stats.todayConversations} /></div>
```

- 首屏：从 0 → 目标值 ~900ms
- 数据刷新（如 30 秒轮询）：spring 过渡到新值
- reduced-motion 下直接显示数字（hook 内判断 `useReducedMotion()`）

### 不做

- token 数（trace 列表）不做 count-up，刷新频率太高会喧宾夺主
- 时间戳/相对时间不做

---

## WP-M8：消息进入 + 流式渐显

### 现状

`chat-message.tsx` assistant 消息追加是 React 直接 mount，无过渡。流式输出的字符瞬时显示。

### 实现

#### M8.1 消息卡片 enter

最新一条消息（user / assistant）加入时，外层做轻 slide-up：

```tsx
<motion.div
  className="assistant-turn"
  initial={{ opacity: 0, y: 6 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
>
```

仅对**新增**的消息，历史滚动加载的旧消息不动（用 `initial={false}` 配合 key 判断，或对前 N 条传 `initial={false}`）。

#### M8.2 流式光标

`assistant-loading` (`chat-message.tsx:149`) 现在是 `<Loader2 spin /> + "正在处理"`。改成更细节的 typing-dot pulse：

```tsx
<div className="assistant-loading">
  {[0, 1, 2].map((i) => (
    <motion.span
      key={i}
      className="typing-dot"
      animate={{ opacity: [0.3, 1, 0.3] }}
      transition={{ duration: 1.0, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
    />
  ))}
</div>
```

替代 `chat.css:539` 的 `@keyframes dotPulse`，行为可控更易调。

### 验收

- 新消息 slide-up 不影响滚动到底部行为
- 流式输出过程中光标动画不卡

---

## WP-M9：拖拽反馈

### 现状

- 知识库右侧栏 drag-to-resize（git status 中 `app/shared/app-nav.tsx`、`knowledge-page.css` 刚改完）
- 聊天的附件 drop zone hover/active 状态

### 实现

#### M9.1 拖拽手柄高亮

drag handle 用 `whileHover` + `whileTap`：

```tsx
<motion.div
  className="resize-handle"
  whileHover={{ backgroundColor: "var(--accent-wash)" }}
  whileTap={{ backgroundColor: "var(--accent-ring)" }}
/>
```

#### M9.2 文件 Drop zone

```tsx
<motion.div
  animate={{
    borderColor: isDragging ? "var(--accent)" : "var(--border)",
    backgroundColor: isDragging ? "var(--accent-wash)" : "transparent",
    scale: isDragging ? 1.005 : 1,
  }}
  transition={EASE_OUT_QUICK}
>
```

符合 `gesture-feedback` 准则（实时跟手）。

---

## WP-M10：页面切换（可选，谨慎）

### 现状

App Router 4 个一级路由（`/cockpit /chat /knowledge /config`）切换瞬时。

### 实现（如果做）

`app/shared/app-shell.tsx` 包裹：

```tsx
"use client";
import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.main
        key={pathname}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -2 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.main>
    </AnimatePresence>
  );
}
```

### 权衡

- 桌面 app 用户高频在 cockpit ↔ chat 切，180ms 延迟可能被嫌"慢"
- Next.js streaming SSR 与 AnimatePresence exit 配合可能出现"闪白"
- **建议**：先不做，等用户反馈"切换太硬"再上

---

## WP-M11：成功 / 失败状态动效

### 现状

工具调用完成显示 `<Check />` / `<X />` 静态图标。

### 实现

完成那一刻做一次性 pop：

```tsx
{pair.status === "done" && (
  <motion.span
    className="tool-step-icon-ok"
    initial={{ scale: 0, rotate: -90 }}
    animate={{ scale: 1, rotate: 0 }}
    transition={{ type: "spring", stiffness: 500, damping: 22 }}
  >
    <Check size={13} />
  </motion.span>
)}
```

类似的：金蝶草稿导出成功、报销校验通过——给个 ~250ms 的 spring pop，强化"完成感"。

### 不做

- 不做撒花/烟花/全屏庆祝——过度，与财务工具调性不符

---

## WP-M12：CSS keyframes 收口

### 现状

6 处 `@keyframes` 散落，且 `spin` 在 `overview.css:185` 与 `workspace.css:569` 重复。

### 改法

| 现 keyframe | 行动 |
|---|---|
| `spin × 2`（两处） | 删除，全部替成 `<AnimatedIcon as={Loader2} preset="spin" />`（WP8 已有） |
| `dotPulse` (chat.css:539) | 替为 WP-M8.2 的 motion 实现，删 CSS |
| `cursorBlink` (preview.css:2) | 保留——纯 CSS 性能更好，且不影响主线 |
| `settings-card-in` (settings-float.css:304) | 改为 motion popIn 接 settings 卡片，保 CSS 兜底 |
| `think-breathe` (workspace.css:724) | 改为 motion `animate={{ opacity: [0.5, 1, 0.5] }} repeat: Infinity` |

收口后 `app/styles/` 下 `@keyframes` 应只剩 1 处（cursorBlink）。

---

## 性能与可访问性 checklist

- [ ] 所有 motion 元素仅动 `transform` / `opacity`（个别 `height: auto` + `overflow: hidden` 例外）
- [ ] `useReducedMotion()` 在 `motion-presets.ts` 集中检测，命中后 `SPRING_DEFAULT` 退化为 `{ duration: 0 }`
- [ ] 列表 stagger 总长度 ≤ 500ms
- [ ] AnimatePresence 内的元素有稳定 `key`
- [ ] layoutId 全局唯一，避免冲突
- [ ] DevTools Performance 录制 cockpit 首屏：无 layout reflow / Long Task > 50ms

---

## 执行顺序

| 阶段 | WP | 估时 | 价值 |
|---|---|---|---|
| **1** 立即可见的赢家 | M1 (tool step), M3 (nav layoutId), M5 (modal motion) | 1 天 | ⭐⭐⭐⭐⭐ |
| **2** 清理与一致性 | M2 (thinking), M6 (sidebar), M8.2 (typing dot), M12 (CSS 收口) | 1 天 | ⭐⭐⭐⭐ |
| **3** 数字与列表 | M4 (stagger lists), M7 (count-up), M11 (success pop) | 0.5 天 | ⭐⭐⭐ |
| **4** 可选 | M8.1 (msg enter), M9 (drag), M10 (page transition) | 0.5 天 | ⭐⭐ |

总计 ~3 天（核心 ~2 天）。

---

## 不做（明确划界）

- 不引入 Lottie 作为主流方案（`spec-ui-polish.md` WP8.5 已说明仅可选 3 处复杂场景）
- 不做 GSAP / Theatre.js（motion 已能覆盖所有场景）
- 不做装饰性微动效（光斑、粒子、视差背景）
- 不在每个 hover 上挂 motion（用 CSS `:hover` 更轻）
- 不做 scroll-triggered animation（这是 landing page 套路，不适合 dashboard）
