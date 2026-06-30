"use client";

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HugeiconsIcon } from "@hugeicons/react";
import { MinusSignIcon, Square01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";

/**
 * 把所在 header 容器标记为 Tauri 窗口拖拽区:空白/间隙处可拖动 + 双击最大化/还原。
 * Tauri 以「鼠标按下的精确目标」判定拖拽区,故子元素(按钮等)点击命中自身、不触发拖拽。
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
    setIsWin("__TAURI_INTERNALS__" in window && /Win/i.test(navigator.userAgent));
  }, []);
  return isWin;
}

/**
 * Windows 自绘窗口控制(最小化 / 最大化-还原 / 关闭),固定窗口右上角。
 * 仅 Windows+Tauri 渲染(mac 用系统红绿灯、linux 保留原生框、web 无)。
 * 复用项目标准 <Button variant="ghost" size="icon"> + Hugeicons,确保与各页 header 的图标按钮
 * (如总览页刷新键)同尺寸/同圆角/同 hover;top-2 使其垂直居中于 h-11 标题栏,与那些按钮对齐。
 * 拖动 / 双击最大化靠各页 header 的 data-tauri-drag-region;窗口 API 权限见 capabilities(remote.urls 含生产动态端口)。
 */
export function WindowControls() {
  const isWin = useIsWindowsApp();
  if (!isWin) return null;
  const win = getCurrentWindow();
  return (
    <div className="fixed right-2 top-2 z-[60] flex items-center gap-0.5" role="group" aria-label="窗口控制">
      <Button variant="ghost" size="icon" aria-label="最小化" onClick={() => void win.minimize()}>
        <HugeiconsIcon icon={MinusSignIcon} size={16} />
      </Button>
      <Button variant="ghost" size="icon" aria-label="最大化 / 还原" onClick={() => void win.toggleMaximize()}>
        <HugeiconsIcon icon={Square01Icon} size={16} />
      </Button>
      <Button variant="ghost" size="icon" aria-label="关闭" onClick={() => void win.close()}>
        <HugeiconsIcon icon={Cancel01Icon} size={16} />
      </Button>
    </div>
  );
}
