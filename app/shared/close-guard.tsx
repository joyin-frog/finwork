"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import { useChatStream } from "@/app/shared/chat-stream";
import { getDesktop } from "@/lib/desktop/client";

/**
 * 桌面版关窗守卫：有活动流时拦截关窗请求，弹应用内确认。
 * 仅在桌面壳环境挂载；浏览器版返回 null，零行为变化。
 *
 * 实现要点：
 * - onCloseRequested 只注册一次（effect[]），通过 ref 读取最新 hasActiveTurns，避免闭包捕获旧值。
 * - 确认退出后调用 destroy()（需 core:window:allow-destroy）：跳过再次 close 事件，直接销毁窗口，
 *   保证 Rust 的 WindowEvent::Destroyed 子进程回收路径照常走。
 */
export function CloseGuard() {
  const { hasActiveTurns } = useChatStream();
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    void desktop.window.setCloseGuard(hasActiveTurns);
    return () => {
      void desktop.window.setCloseGuard(false);
    };
  }, [hasActiveTurns]);

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    return desktop.window.onCloseRequested(() => setConfirmOpen(true));
  }, []);

  function handleConfirm() {
    setConfirmOpen(false);
    void getDesktop()?.window.forceClose();
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
