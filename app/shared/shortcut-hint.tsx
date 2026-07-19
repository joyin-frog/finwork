"use client";

import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMac } from "@/app/shared/use-is-mac";
import { formatShortcut } from "@/app/shared/shortcuts";

/** 带快捷键的按钮 hover 提示:动作名 + 按平台格式化的按法。 */
export function ShortcutHint({
  label,
  combo,
  side = "bottom",
  sideOffset = 0,
  collisionPadding = 0,
  children
}: {
  label: string;
  combo: string;
  side?: "top" | "bottom" | "left" | "right";
  /** 与触发器间距；侧栏顶栏等靠窗缘控件可加大以免贴边。 */
  sideOffset?: number;
  /** 视口碰撞边距；侧栏顶栏传非零值，避免提示伸入 Windows 自绘标题栏。 */
  collisionPadding?: number;
  children: React.ReactNode;
}) {
  const isMac = useIsMac();
  // TooltipTrigger asChild 与 DropdownMenuTrigger asChild 的嵌套是 shadcn 官方
  // Tooltip+DropdownMenu 组合的标准用法,props 经 Slot 链合并到叶子按钮。
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} collisionPadding={collisionPadding}>
        {label}
        <Kbd>{formatShortcut(combo, isMac)}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
