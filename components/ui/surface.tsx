import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Surface 原语 — 结构 vs 外观解耦。
 *
 * 页面代码不直接写 rounded/shadow/border 族；
 * 全部经由 <Surface level edge shape> 获得外观。
 *
 * 实施注意（spec-ui-foundation.md reviewer 附带）：
 *   --radius-chip 只在 :root 声明，Surface 用
 *   rounded-[var(--radius-chip)] 任意值语法消费，
 *   与 shadow-[var(--elevation-*)] 同一机制。
 *
 * variant 值全部来自三个试点文件的现状写法，视觉零变化。
 */
const surfaceVariants = cva("", {
  variants: {
    /**
     * level – 背景 + elevation 高度档
     *   page    : --color-background（页面底板）
     *   panel   : --color-card + elevation-1（轻提升面板）
     *   card    : --color-card + elevation-1（常规卡片）
     *   overlay : --color-popover + elevation-3（浮层/抽屉）
     */
    level: {
      page: "bg-background",
      // panel 与 card 当前 class 相同是有意的：
      // 两者处于同一 elevation 档（轻提升），语义上 panel 表示区域面板、card 表示数据卡片。
      // 视觉差异留给未来风格包（WP8b+）通过 CSS 变量差异化，现阶段保持一致避免引入不必要分叉。
      panel: "bg-card shadow-[var(--elevation-1)]",
      card: "bg-card shadow-[var(--elevation-1)]",
      overlay: "bg-popover shadow-[var(--elevation-3)]",
    },
    /**
     * edge – 边框
     *   none     : 无边框
     *   hairline : border + border-border（试点最常见）
     *   strong   : border-2 + border-border（强调边框）
     */
    edge: {
      none: "",
      hairline: "border border-border",
      strong: "border-2 border-border",
    },
    /**
     * shape – 圆角
     *   none    : 无圆角
     *   chip    : rounded-[var(--radius-chip)]（0.25rem；承接 8 处裸 rounded）
     *   control : rounded-md（试点 19 处）
     *   card    : rounded-lg（resource-card 卡片本体等）
     *   panel   : rounded-xl
     *   overlay : rounded-2xl
     *   pill    : rounded-full（5 处）
     */
    shape: {
      none: "",
      chip: "rounded-[var(--radius-chip)]",
      control: "rounded-md",
      card: "rounded-lg",
      panel: "rounded-xl",
      overlay: "rounded-2xl",
      pill: "rounded-full",
    },
    /**
     * inset – 内嵌阴影（主内容大卡片浮在侧栏背板上）
     */
    inset: {
      true: "shadow-[var(--elevation-inset)]",
      false: "",
    },
  },
  defaultVariants: {
    level: "card",
    edge: "hairline",
    shape: "card",
    inset: false,
  },
});

type SurfaceProps = React.ComponentProps<"div"> &
  VariantProps<typeof surfaceVariants> & {
    asChild?: boolean;
  };

/**
 * Surface 原语组件。
 *
 * @example
 * // 卡片（默认）
 * <Surface>内容</Surface>
 *
 * @example
 * // 状态标签 chip
 * <Surface level="page" edge="hairline" shape="chip" className="px-2 py-0.5 text-meta">
 *   已确认
 * </Surface>
 *
 * @example
 * // 浮层
 * <Surface level="overlay" edge="hairline" shape="overlay">
 *   菜单内容
 * </Surface>
 */
function Surface({
  level,
  edge,
  shape,
  inset,
  className,
  children,
  ...props
}: SurfaceProps) {
  return (
    <div
      data-slot="surface"
      className={cn(surfaceVariants({ level, edge, shape, inset }), className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { Surface, surfaceVariants };
