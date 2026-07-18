"use client";

import { Suspense, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { toast, Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppNav } from "@/app/shared/app-nav";
import { GlobalShortcuts } from "@/app/shared/global-shortcuts";
import { ChatFloat } from "@/app/shared/chat-float";
import { IsMacProvider } from "@/app/shared/use-is-mac";
import { useDetectPlatform, WindowTitleBar } from "@/app/shared/window-controls";
import { FirstRunGate } from "@/app/shared/first-run-gate";
import { useNavState } from "@/app/shared/nav-state";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  useDetectPlatform();
  const { collapsed } = useNavState();

  // 把侧栏收起态写到 <html> 上,供 CSS 依 data-nav-collapsed 做条件样式(同 useDetectPlatform 写 data-platform 的做法)。
  useEffect(() => {
    document.documentElement.dataset.navCollapsed = String(collapsed);
  }, [collapsed]);

  // 启动触发遥测上报:fire-and-forget,失败静默,节流由 reporter 内部保证(每天最多一次)。
  useEffect(() => {
    fetch("/api/telemetry/report", { method: "POST" }).catch(() => {});
  }, []);

  // §17.2 首启一次性非阻塞告知:读 telemetry:disclosureShown 标志,未见过则展示 toast。
  // 不阻塞启动,不需要用户操作,仅告知可在设置关闭。
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings/app?key=telemetry%3AdisclosureShown");
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { value?: string } };
        if (body.data?.value === "1") return; // 已展示过,跳过
        // 未展示:记标志 + 展示 toast
        await fetch("/api/settings/app", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "telemetry:disclosureShown", value: "1" }),
        }).catch(() => {});
        toast("使用数据上报", {
          description:
            "本应用上传匿名运行指标与错误日志以改进产品,不含财务数据,可在设置随时关闭。",
          duration: 8000,
          action: {
            label: "去设置",
            onClick: () => {
              window.location.href = "/config?tab=about";
            },
          },
        });
      } catch {
        // best-effort,失败静默
      }
    })();
  }, []);

  // 全局客户端错误监听(§16.1):一次性挂载,fire-and-forget,失败静默,不造成错误循环。
  useEffect(() => {
    function postError(kind: "unhandled" | "rejection", msg: string, stack?: string) {
      try {
        fetch("/api/errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, source: "window", message: msg, stack: stack ?? null }),
        }).catch(() => {});
      } catch {
        // 静默:错误上报本身不能再抛
      }
    }

    function onError(event: ErrorEvent) {
      postError("unhandled", event.message ?? "Unknown error", event.error?.stack ?? undefined);
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection");
      const stack = reason instanceof Error ? reason.stack ?? undefined : undefined;
      postError("rejection", msg, stack);
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  let active: "cockpit" | "chat" | "knowledge" | "config" | "files" | "agents" | "skills" = "cockpit";
  let chatActive: "new" | "recent" | undefined;

  if (pathname.startsWith("/chat")) {
    active = "chat";
    chatActive = pathname === "/chat/new" ? "new" : "recent";
  } else if (pathname.startsWith("/knowledge")) {
    active = "knowledge";
  } else if (pathname.startsWith("/files")) {
    active = "files";
  } else if (pathname.startsWith("/agents")) {
    active = "agents";
  } else if (pathname.startsWith("/skills")) {
    active = "skills";
  } else if (pathname.startsWith("/config")) {
    active = "config";
  }

  return (
    <IsMacProvider>
    <TooltipProvider delayDuration={300}>
      {/* 默认风格的窗口底层使用页面底色；现代风格由 .app-shell 改为 --sidebar，
          与侧栏、Windows 标题栏组成连续外壳。主导航只在侧栏与页面头部，不渲染顶部标签栏。 */}
      <div className="app-shell flex h-screen flex-col overflow-hidden bg-background">
        <WindowTitleBar />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <a
            href="#main-content"
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-background focus:border focus:rounded-md focus:text-sm"
          >
            跳转到主内容
          </a>
          <Suspense fallback={null}>
            <AppNav active={active} chatActive={chatActive} />
          </Suspense>
          <main
            id="main-content"
            tabIndex={-1}
            className="app-main flex-1 min-w-0 overflow-auto bg-background"
          >
            <FirstRunGate>{children}</FirstRunGate>
          </main>
          <Suspense fallback={null}>
            <GlobalShortcuts />
          </Suspense>
          <Suspense fallback={null}>
            <ChatFloat />
          </Suspense>
          <Toaster position="top-center" theme={resolvedTheme as "light" | "dark" | "system" | undefined} />
        </div>
      </div>
    </TooltipProvider>
    </IsMacProvider>
  );
}
