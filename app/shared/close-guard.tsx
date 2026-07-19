"use client";

import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import { useChatStream } from "@/app/shared/chat-stream";

/**
 * 桌面版关窗守卫：有活动流时拦截关窗请求，弹应用内确认。
 * 仅在 Tauri 环境挂载；浏览器版返回 null，零行为变化。
 *
 * 实现要点：
 * - onCloseRequested 只注册一次（effect[]），通过 ref 读取最新 hasActiveTurns，避免闭包捕获旧值。
 * - 确认退出后调用 destroy()（需 core:window:allow-destroy）：跳过再次 close 事件，直接销毁窗口，
 *   保证 Rust 的 WindowEvent::Destroyed 子进程回收路径照常走。
 */
export function CloseGuard() {
  const { hasActiveTurns } = useChatStream();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // ref 持最新值，监听器（注册一次）通过 ref 读取，不需要重注册
  const hasActiveTurnsRef = useRef(hasActiveTurns);
  hasActiveTurnsRef.current = hasActiveTurns;

  useEffect(() => {
    if (!isTauri()) return;

    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void win
      .onCloseRequested((event) => {
        if (hasActiveTurnsRef.current) {
          event.preventDefault();
          setConfirmOpen(true);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => unlisten?.();
  }, []);

  function handleConfirm() {
    setConfirmOpen(false);
    // preventDefault 之后必须 destroy 才能真正关窗；再次 close() 可能再次进入守卫。
    void getCurrentWindow().destroy();
  }

  function handleOpenChange(open: boolean) {
    setConfirmOpen(open);
  }

  return (
    <ConfirmDialog
      open={confirmOpen}
      onOpenChange={handleOpenChange}
      title="智能体正在执行任务"
      description="现在退出会中断进行中的回合，已完成的部分会保留。"
      confirmLabel="仍要退出"
      destructive
      onConfirm={handleConfirm}
    />
  );
}
