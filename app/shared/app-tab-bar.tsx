"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  DashboardSquare02Icon,
  BubbleChatIcon,
  LibraryIcon,
  Folder02Icon,
  UserGroupIcon,
  NoteIcon,
  Settings02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { DragHandle } from "@/app/shared/window-controls";
import { NavTopControls } from "@/app/shared/nav-top-controls";
import { appTabKeyFromRoute, resolveSelectedAppTabKey, type PageKind, useNavState } from "@/app/shared/nav-state";
import { useChatStream } from "@/app/shared/chat-stream";
import { cn } from "@/lib/utils";

const PAGE_ICON: Record<PageKind, IconSvgElement> = {
  cockpit: DashboardSquare02Icon,
  "chat-new": BubbleChatIcon,
  knowledge: LibraryIcon,
  files: Folder02Icon,
  agents: UserGroupIcon,
  skills: NoteIcon,
  config: Settings02Icon,
};

function AppTabBarContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { appTabs, activeAppTabKey, activateAppTab, closeAppTab } = useNavState();
  const { statusByConversationId } = useChatStream();
  const routeKey = appTabKeyFromRoute(pathname, searchParams.toString());
  const selectedKey = resolveSelectedAppTabKey(routeKey, activeAppTabKey, appTabs);

  function openTab(key: string, href: string) {
    activateAppTab(key);
    router.push(href);
  }

  function closeTab(key: string) {
    const wasCurrent = selectedKey === key;
    const nextActive = closeAppTab(key);
    if (wasCurrent) router.push(nextActive.href);
  }

  return (
    <div className="app-tabbar hidden relative shrink-0 items-center gap-2">
      <DragHandle />
      <div className="app-tabbar-lead flex items-center gap-1 shrink-0">
        <NavTopControls />
      </div>
      <div className="app-tab-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="已打开的页面和对话">
        {appTabs.map((tab) => {
          const selected = selectedKey === tab.key;
          const status = tab.kind === "conversation" ? statusByConversationId[tab.conversationId] : undefined;
          const icon = tab.kind === "page" ? PAGE_ICON[tab.pageKind] : BubbleChatIcon;
          return (
            <div
              key={tab.key}
              className={cn("app-tab flex items-center h-7 text-small", selected && "is-active")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={tab.title}
                className="app-tab-label flex min-w-0 flex-1 items-center gap-1.5 pl-3"
                onClick={() => openTab(tab.key, tab.href)}
              >
                {status && status !== "incomplete" ? (
                  <span
                    className={cn("app-tab-status shrink-0", status === "streaming" && "is-streaming", (status === "error" || status === "stopped") && "is-error")}
                    aria-label={status === "streaming" ? "正在生成" : status === "done" ? "生成完成" : "未正常完成"}
                    role="status"
                  />
                ) : (
                  <HugeiconsIcon icon={icon} className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                className="app-tab-close shrink-0"
                aria-label={`关闭标签：${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.key);
                }}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={10} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AppTabBar() {
  return (
    <Suspense fallback={null}>
      <AppTabBarContent />
    </Suspense>
  );
}
