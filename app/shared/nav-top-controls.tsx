"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { PanelLeftIcon, LayoutAlignLeftIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useNavState } from "@/app/shared/nav-state";
import { ShortcutHint } from "@/app/shared/shortcut-hint";

/**
 * 搜索按钮 + 侧栏折叠/展开切换按钮。
 * 默认风格:挂在 app-nav-topbar 里(展开态可见);
 * Linear 风格:挂在 app-tabbar 里(收起/展开态都可见,且可重新展开)。
 */
export function NavTopControls() {
  const { collapsed, setCollapsed, setSearchOpen } = useNavState();
  return (
    <>
      <ShortcutHint label="搜索" combo="mod+g" side="right">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="搜索"
          // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
          className="icon-btn relative inline-flex items-center justify-center rounded-lg text-foreground/60 cursor-pointer transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Search01Icon} size={16} />
        </button>
      </ShortcutHint>
      <ShortcutHint label={collapsed ? "展开菜单" : "收起菜单"} combo="mod+b" side="right">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "展开菜单" : "收起菜单"}
          // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
          className="icon-btn relative inline-flex items-center justify-center rounded-lg text-foreground/60 cursor-pointer transition-colors hover:bg-accent hover:text-foreground"
        >
          {/* 收起态显示"展开"图标、展开态显示"收起"图标——两态两 icon,与经典风格页头(SidebarToggle 用 LayoutAlignLeft)一致 */}
          <HugeiconsIcon icon={collapsed ? LayoutAlignLeftIcon : PanelLeftIcon} size={16} />
        </button>
      </ShortcutHint>
    </>
  );
}
