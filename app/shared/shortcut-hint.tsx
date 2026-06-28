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
  children
}: {
  label: string;
  combo: string;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
}) {
  const isMac = useIsMac();
  // TooltipTrigger asChild 与 DropdownMenuTrigger asChild 的嵌套是 shadcn 官方
  // Tooltip+DropdownMenu 组合的标准用法,props 经 Slot 链合并到叶子按钮。
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        <Kbd>{formatShortcut(combo, isMac)}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
