"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { LayoutAlignLeftIcon } from "@hugeicons/core-free-icons";
import { useNavState } from "@/app/shared/nav-state";
import { useIsMac } from "@/app/shared/use-is-mac";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 折叠/展开左侧栏的按钮,放在各页面 header 最左侧。
 * 侧栏收起后整列宽度归零,内容铺满;此时 header 在窗口最左,需为 macOS 红绿灯留出左侧空间,
 * 形成「红绿灯 → 折叠按钮 → 标题」的一行布局。展开时侧栏占据左侧(红绿灯在侧栏顶部),按钮只需常规内边距。
 */
export function SidebarToggle() {
  const { collapsed, setCollapsed } = useNavState();
  const isMac = useIsMac();
  // 展开时折叠按钮在侧栏里(见 app-nav),内容栏不放;但留一点左侧缩进,让标题不要贴边。
  if (!collapsed) return <div className="w-3 shrink-0" aria-hidden />;
  return (
    <div className={cn("flex items-center shrink-0", isMac ? "pl-[70px]" : "pl-2")}>
      <ShortcutHint label={collapsed ? "展开菜单" : "收起菜单"} combo="mod+b" side="right">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "展开菜单" : "收起菜单"}
        >
          <HugeiconsIcon icon={LayoutAlignLeftIcon} size={16} />
        </Button>
      </ShortcutHint>
    </div>
  );
}
