"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

/**
 * 把所在 header 容器标记为 Tauri 窗口拖拽区:空白/间隙处可拖动 + 双击最大化/还原。
 * Tauri 以「鼠标按下的精确目标」判定拖拽区,故子元素(按钮等)点击命中自身、不触发拖拽,
 * 不影响任何交互。比旧的「absolute inset-0 + z-index:-1 覆盖层」可靠(那层被父背景挡住、收不到事件)。
 */
export function DragHandle() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    parent.setAttribute("data-tauri-drag-region", "");
    return () => parent.removeAttribute("data-tauri-drag-region");
  }, []);
  return <span ref={ref} className="hidden" aria-hidden />;
}

export function useDetectPlatform() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let platform: "macos" | "windows" | "linux" | "web" = "web";
    if ("__TAURI_INTERNALS__" in window) {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      platform = /Mac/i.test(ua) ? "macos" : /Win/i.test(ua) ? "windows" : "linux";
    }
    document.documentElement.dataset.platform = platform;
  }, []);
}

/** 仅 Windows + Tauri 为真:此时窗口无边框(见 lib.rs 的 decorations(false)),需 Web 自绘标题栏控制。 */
export function useIsWindowsApp() {
  const [isWin, setIsWin] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const inTauri = "__TAURI_INTERNALS__" in window;
    const onWin = /Win/i.test(navigator.userAgent);
    setIsWin(inTauri && onWin);
  }, []);
  return isWin;
}

function CaptionButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-[46px] items-center justify-center text-foreground/70 transition-colors",
        danger ? "hover:bg-[var(--tone-alarm)] hover:text-white" : "hover:bg-foreground/10 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/**
 * Windows 自绘窗口控制(最小化 / 最大化-还原 / 关闭),固定窗口右上角。
 * 仅 Windows+Tauri 渲染(mac 用系统红绿灯、linux 保留原生框、web 无)。窗口无边框由 lib.rs 设定;
 * 缩放靠 tao 保留的 WS_THICKFRAME(窗口边缘),拖动 / 双击最大化靠各页 header 的 data-tauri-drag-region。
 */
export function WindowControls() {
  const isWin = useIsWindowsApp();
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    if (!isWin) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaxed);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaxed);
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, [isWin]);

  if (!isWin) return null;

  const win = getCurrentWindow();
  return (
    <div className="fixed right-0 top-0 z-[60] flex h-8 select-none" role="group" aria-label="窗口控制">
      <CaptionButton label="最小化" onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <line x1="0" y1="5.5" x2="10" y2="5.5" stroke="currentColor" />
        </svg>
      </CaptionButton>
      <CaptionButton label={maxed ? "向下还原" : "最大化"} onClick={() => void win.toggleMaximize()}>
        {maxed ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden>
            <rect x="0.5" y="2.5" width="6" height="6" />
            <path d="M2.5 2.5 V0.5 H9.5 V7.5 H6.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </CaptionButton>
      <CaptionButton label="关闭" danger onClick={() => void win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" aria-hidden>
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </CaptionButton>
    </div>
  );
}
