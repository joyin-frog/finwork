"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function getDefaultW(containerW: number, pct = 0.42) {
  return Math.max(280, Math.min(800, Math.round(containerW * pct)));
}

/**
 * 纯函数：把拖拽原始宽度夹制到合法范围。
 *
 * raw = startW - deltaX（面板向左拖拽时增宽，deltaX 为负）
 * max = Math.max(200, containerW - handleW - listMinW)（保留列表最小宽 + 分隔条宽）
 * result = Math.max(200, Math.min(max, raw))
 *
 * handleW 由 usePreviewResize 外层参数传入（默认 4），此处不写死。
 */
export function clampPreviewWidth({
  startW,
  deltaX,
  containerW,
  listMinW,
  handleW,
}: {
  startW: number;
  deltaX: number;
  containerW: number;
  listMinW: number;
  handleW: number;
}): number {
  const raw = startW - deltaX;
  const max = Math.max(200, containerW - handleW - listMinW);
  return Math.max(200, Math.min(max, raw));
}

/**
 * 共享的预览侧栏拖拽 resize hook。
 *
 * AC2:previewW 上限 = containerW - listMinW - handleW,预览面板永不超出容器。
 * listMinW 默认 300(列表最小宽),handleW 默认 4(1px divider + 3px 余量)。
 */
export function usePreviewResize(listMinW = 300, handleW = 4) {
  const [collapsed, setCollapsed] = useState(true);
  const [previewW, setPreviewW] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const draggingRef = useRef(false);
  const touchedRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);

  // Auto-size on mount / container resize (only before user touches)
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      if (!touchedRef.current) setPreviewW(getDefaultW(main.clientWidth));
    };
    sync();
    const obs = new ResizeObserver(sync);
    obs.observe(main);
    return () => obs.disconnect();
  }, []);

  const beginResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      touchedRef.current = true;
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWRef.current = previewW;
      setDragging(true);
      setMaximized(false);

      const onMove = (ev: MouseEvent) => {
        const containerW = mainRef.current?.clientWidth ?? 1400;
        // panel grows leftward so delta is negative when dragging left
        // 上限留够 listMinW 给列表列:拖拽不能把预览拉到几乎全覆盖、挤塌列表;真要全屏走 maximize()。
        setPreviewW(clampPreviewWidth({
          startW: startWRef.current,
          deltaX: ev.clientX - startXRef.current,
          containerW,
          listMinW,
          handleW,
        }));
      };
      const onUp = () => {
        setDragging(false);
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [previewW, listMinW, handleW],
  );

  function toggle() {
    touchedRef.current = true;
    if (!collapsed && maximized) {
      // 即将收起 → 复位放大并还原默认宽,否则列表列仍被 maximized 隐藏,主区全空无路可退
      // (对齐 chat-page toggleSidebar 的同款处理)
      setMaximized(false);
      setPreviewW(getDefaultW(mainRef.current?.clientWidth ?? 1200));
    }
    setCollapsed((prev) => !prev);
  }
  function open() {
    touchedRef.current = true;
    setCollapsed(false);
  }
  function resetWidth() {
    touchedRef.current = true;
    setMaximized(false);
    setPreviewW(getDefaultW(mainRef.current?.clientWidth ?? 1200));
  }
  /** 放大:预览铺满内容区(只剩左侧菜单);已满则还原默认宽。切换式。 */
  function maximize() {
    touchedRef.current = true;
    setCollapsed(false);
    const containerW = mainRef.current?.clientWidth ?? 1400;
    const max = Math.max(0, containerW - handleW);
    setMaximized((wasMax) => {
      setPreviewW(wasMax ? getDefaultW(containerW) : max);
      return !wasMax;
    });
  }

  return { collapsed, previewW, dragging, maximized, mainRef, beginResize, toggle, open, resetWidth, maximize };
}
