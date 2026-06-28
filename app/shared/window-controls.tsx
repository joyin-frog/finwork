"use client";

import { useEffect, useRef } from "react";

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
