"use client";

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HugeiconsIcon } from "@hugeicons/react";
import { MinusSignIcon, AppWindowIcon, Copy01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
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

/**
 * 开发期视觉预览:在 mac / 普通浏览器 `npm run dev` 里也把 Windows 自绘标题栏渲染出来,方便调布局/样式
 * (Next 热更新、随改随看、免打包)。三键在无 Tauri 环境点了不做事——只用于对位、间距、分隔线、图标等纯视觉。
 * 触发:地址栏加 ?winchrome=1(写入 localStorage 持久生效),?winchrome=0 关闭。
 * 双重护栏:仅在「非生产构建」且「非真 Tauri」时生效,绝不影响打包端(打包端走真实 UA 判定)。
 */
export function useWinChromePreview() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return;
    try {
      const q = new URLSearchParams(window.location.search).get("winchrome");
      if (q === "1") localStorage.setItem("dev:winchrome", "1");
      else if (q === "0") localStorage.removeItem("dev:winchrome");
      setOn(localStorage.getItem("dev:winchrome") === "1");
    } catch {
      // localStorage 不可用:静默,不预览
    }
  }, []);
  return on;
}

export function useDetectPlatform() {
  const preview = useWinChromePreview();
  useEffect(() => {
    if (typeof window === "undefined") return;
    let platform: "macos" | "windows" | "linux" | "web" = "web";
    if ("__TAURI_INTERNALS__" in window) {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      platform = /Mac/i.test(ua) ? "macos" : /Win/i.test(ua) ? "windows" : "linux";
    }
    if (preview) platform = "windows"; // dev 预览:让 data-platform 相关样式(侧栏靠左等)也一并生效
    document.documentElement.dataset.platform = platform;
  }, [preview]);
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
 * Windows 自绘标题栏:无边框窗(见 lib.rs 的 decorations(false))下,顶部一条独立的 32px 拖拽条,
 * 三键(最小化 / 最大化↔还原 / 关闭)固定在右端,底部一条分隔横线把「窗口控制区」与「页面内容」分层。
 * 这样三键彻底离开内容区,不再靠 padding 硬躲——各页 header / 浮动预览卡的右侧内容不会再被盖或被推。
 *
 * 仅 Windows+Tauri 渲染(mac 用系统红绿灯、linux 原生框、web 无);非 Windows 返回 null,
 * 作为 app-shell flex 列的首个子项不占高度 → mac/linux/web 布局零影响。
 * 整条 data-tauri-drag-region 可拖动 + 双击最大化;三键是其子元素,按下命中自身不触发拖拽。
 * 复用项目标准 <Button variant="ghost" size="icon">(32px,见 globals.css 的 .icon-btn)+ Hugeicons,与各页图标按钮同风格。
 * 另:dev 预览(?winchrome=1)下也渲染,但此时无窗口 API,三键点击不做事(见 hasWindow)。
 */
export function WindowTitleBar() {
  const isWin = useIsWindowsApp();
  const preview = useWinChromePreview();
  const hasWindow = isWin; // 只有真 Tauri 才有 getCurrentWindow 可用;dev 预览无窗口 API
  const [maximized, setMaximized] = useState(false);

  // 同步最大化态用于切换中键图标:还原态=窗口图标(AppWindow),最大化态=双框叠放(Copy01,即 Windows 还原图标)。
  // 注意 Hugeicons 的 Square01 渲染的是 x²(数学符号)不是方框,故窗口用 AppWindow。
  // onResized 覆盖最大化/还原/边缘缩放触发的尺寸变化;非 Windows 不订阅。
  useEffect(() => {
    if (!hasWindow) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [hasWindow]);

  if (!isWin && !preview) return null;
  const win = hasWindow ? getCurrentWindow() : null;
  return (
    <div
      data-tauri-drag-region
      // relative z-[60]:让顶栏叠在全屏模态(如设置 fixed inset-0 z-50)之上,任何时候都能最小化/关窗
      // ——沿用旧浮动控件的 z-[60];position:relative 保留其在 flex 列中的 32px 占位。
      className="relative z-[60] flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-border bg-background pr-1"
      role="group"
      aria-label="窗口控制"
    >
      <Button variant="ghost" size="icon" aria-label="最小化" onClick={() => win && void win.minimize()}>
        <HugeiconsIcon icon={MinusSignIcon} size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => win && void win.toggleMaximize()}
      >
        <HugeiconsIcon icon={maximized ? Copy01Icon : AppWindowIcon} size={maximized ? 14 : 16} />
      </Button>
      <Button variant="ghost" size="icon" aria-label="关闭" onClick={() => win && void win.close()}>
        <HugeiconsIcon icon={Cancel01Icon} size={16} />
      </Button>
    </div>
  );
}
