"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Kbd } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";
import { useNavState } from "@/app/shared/nav-state";
import { useIsMac } from "@/app/shared/use-is-mac";
import { formatShortcut, resolveShortcut, SHORTCUTS } from "@/app/shared/shortcuts";
import { GlobalSearchDialog } from "@/app/shared/global-search-dialog";
import { cn } from "@/lib/utils";

const SHORTCUT_EVENT = "app-shortcut";

export function scheduleDialogMotionReset(
  open: boolean,
  reset: () => void,
  schedule?: (callback: FrameRequestCallback) => number,
  cancel?: (handle: number) => void,
) {
  if (open) return undefined;
  const scheduleFrame = schedule ?? requestAnimationFrame;
  const cancelFrame = cancel ?? cancelAnimationFrame;
  const handle = scheduleFrame(() => reset());
  return () => cancelFrame(handle);
}

/** chat 等局部作用域的快捷键经语义化事件到达组件内 state,不提升 state。 */
export function useShortcutEvent(id: string, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === id) handlerRef.current();
    };
    window.addEventListener(SHORTCUT_EVENT, listener);
    return () => window.removeEventListener(SHORTCUT_EVENT, listener);
  }, [id]);
}

/** 唯一的全局 keydown 监听:决策交给 resolveShortcut 纯内核。挂在 AppShell。 */
export function GlobalShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const { collapsed, setCollapsed, searchOpen, setSearchOpen } = useNavState();
  const isMac = useIsMac();
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchInstant, setSearchInstant] = useState(false);
  const [helpInstant, setHelpInstant] = useState(false);

  // Keep the trigger source through the closed render. Resetting in onOpenChange
  // would re-enable data-closed animation classes in the same React batch.
  useEffect(
    () => scheduleDialogMotionReset(searchOpen, () => setSearchInstant(false)),
    [searchOpen],
  );
  useEffect(
    () => scheduleDialogMotionReset(helpOpen, () => setHelpInstant(false)),
    [helpOpen],
  );

  const stateRef = useRef({ collapsed, pathname, isMac, setSearchOpen });
  stateRef.current = { collapsed, pathname, isMac, setSearchOpen };

  // 允许外部代码(e2e、导航展开态等)通过事件派发打开全局搜索
  useEffect(() => {
    const onShortcutEvent = (event: Event) => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === "global-search") {
        setSearchInstant(true);
        setSearchOpen(true);
      }
    };
    window.addEventListener(SHORTCUT_EVENT, onShortcutEvent);
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcutEvent);
  }, [setSearchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      const { collapsed: navCollapsed, pathname: currentPath, isMac: mac, setSearchOpen: openSearch } = stateRef.current;
      const targetEl = event.target as HTMLElement | null;
      const id = resolveShortcut(
        event,
        { tagName: targetEl?.tagName ?? "", isContentEditable: Boolean(targetEl?.isContentEditable) },
        // search-skills 只挂在 /skills 列表页(SkillsManager);详情页 /skills/[name] 无 handler,
        // 用精确匹配避免在详情页 preventDefault 掉浏览器查找却无人接住。
        { isMac: mac, scope: currentPath.startsWith("/chat") ? "chat" : currentPath.startsWith("/config") ? "config" : currentPath === "/skills" ? "skills" : undefined }
      );
      if (!id) return;
      event.preventDefault();

      switch (id) {
        case "new-chat":
          router.push("/chat/new");
          break;
        case "toggle-nav":
          setCollapsed(!navCollapsed);
          break;
        case "open-settings":
          router.push("/config");
          break;
        case "show-shortcuts":
          setHelpInstant(true);
          setHelpOpen((open) => !open);
          break;
        case "global-search":
          setSearchInstant(true);
          openSearch(true);
          break;
        default:
          window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: { id } }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, setCollapsed]);

  return (
    <>
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} isMac={isMac} instant={helpInstant} />
      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} instant={searchInstant} />
    </>
  );
}

const GROUPS: Array<{ title: string; scopes: Array<"global" | "chat" | "composer" | "config" | "skills"> }> = [
  { title: "对话输入", scopes: ["composer"] },
  { title: "全局与面板", scopes: ["global", "chat", "config", "skills"] },
];

function ShortcutsHelpDialog({
  open,
  onOpenChange,
  isMac,
  instant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMac: boolean;
  instant: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* 与全局搜索一致:浅色无模糊遮罩 */}
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className={cn("fixed inset-0 z-50 bg-scrim-modal", !instant && "duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0")}
        />
        {/* eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则 */}
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn("fixed top-[18%] left-1/2 z-50 w-full max-w-[calc(100%-2rem)] sm:max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border-2 border-border bg-popover text-popover-foreground outline-none", !instant && "duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95")}
        >
          {/* 标题行 + 关闭按钮(右侧竖直居中),下方横线分隔 */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="flex-1 font-heading text-title">快捷键</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="关闭" className="-mr-1.5 shrink-0">
                <HugeiconsIcon icon={Cancel01Icon} size={18} />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-4 py-3 flex flex-col gap-4">
            {GROUPS.map((group) => (
              <div key={group.title} className="flex flex-col gap-1.5">
                <p className="text-meta text-muted-foreground tracking-wider">{group.title}</p>
                {SHORTCUTS.filter((s) => group.scopes.includes(s.scope)).map((shortcut) => (
                  // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                  <div key={shortcut.id} className="flex items-center justify-between gap-3 text-body py-1.5 -mx-2 px-2 rounded-md hover:bg-muted transition-colors">
                    <span>
                      {shortcut.description}
                      {shortcut.webLimited ? (
                        <span className="ml-1 text-meta text-muted-foreground">(浏览器模式可能被占用)</span>
                      ) : null}
                    </span>
                    <Kbd>{formatShortcut(shortcut.combo, isMac)}</Kbd>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
