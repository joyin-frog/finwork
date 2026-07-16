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
 * - bypassRef：用户确认退出后置 true，监听器里直接放行（不再弹框），保证 Rust 的 kill 路径照常走。
 * - 取消确认后 bypassRef 保持 false（初始值），下次关窗仍会弹框。
 */
export function CloseGuard() {
  const { hasActiveTurns } = useChatStream();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // ref 持最新值，监听器（注册一次）通过 ref 读取，不需要重注册
  const hasActiveTurnsRef = useRef(hasActiveTurns);
  hasActiveTurnsRef.current = hasActiveTurns;

  // 确认退出后置 true，让监听器直接放行，保证走到 Rust 的子进程 kill 路径
  const bypassRef = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;

    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void win
      .onCloseRequested((event) => {
        if (bypassRef.current) {
          // 用户已确认退出，本次直接放行
          bypassRef.current = false;
          return;
        }
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
    bypassRef.current = true;
    void getCurrentWindow().close();
  }

  function handleOpenChange(open: boolean) {
    setConfirmOpen(open);
    // 取消时 bypassRef 不变（保持 false），下次关窗仍弹确认
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
