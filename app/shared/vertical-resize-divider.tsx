"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type VerticalResizeDividerProps = Omit<ComponentProps<"div">, "role" | "aria-orientation"> & {
  "aria-label": string;
};

/**
 * 全站纵向拖拽分隔区。
 *
 * 组件本身透明，直接覆盖或占据页面已有的列边界。4px 命中宽度贯穿容器整高，
 * 不再额外绘制一条短手柄；键盘聚焦时才显示弱提示。
 */
export function VerticalResizeDivider({ className, ...props }: VerticalResizeDividerProps) {
  return (
    <div
      className={cn(
        "w-1 shrink-0 self-stretch cursor-col-resize bg-transparent outline-none",
        "focus-visible:bg-primary/15",
        className,
      )}
      role="separator"
      aria-orientation="vertical"
      {...props}
    />
  );
}
