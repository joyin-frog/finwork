import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 卡片底部固定操作区：预留高度，内容多少都不会改变按钮位置。 */
export function CardActionDock({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-auto flex min-h-7 items-center pt-1 opacity-0 transition-opacity",
        "group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}
