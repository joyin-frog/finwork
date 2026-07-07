"use client";

import { useState, useEffect } from "react";
import { useShortcutEvent } from "@/app/shared/global-shortcuts";

/**
 * find-in-chat 浮窗状态 + URL ?find= 参数读取。
 * 交叉最少（不依赖 conversationId / turn / draft 等主状态），
 * 提供 findOpen / findInitial 及相关控制器。
 *
 * @param setFilePanelOpen 打开 find 浮窗时收起文件面板（避免遮挡右上角）
 */
export function useChatNavigation({
  setFilePanelOpen,
}: {
  setFilePanelOpen: (open: boolean) => void;
}) {
  const [findOpen, setFindOpen] = useState(false);
  const [findInitial, setFindInitial] = useState("");

  // 读取 URL ?find= 参数:自动打开对话内查找(供 Plan 037 全局搜索跳转复用)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const findQ = params.get("find");
    if (findQ) {
      setFindInitial(findQ);
      setFindOpen(true);
      setFilePanelOpen(false); // 折叠文件面板,避免盖住右上角查找浮窗
      // 清掉 find 参数,避免刷新重复触发
      params.delete("find");
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
      window.history.replaceState(null, "", newUrl);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useShortcutEvent("find-in-chat", () => { setFindInitial(""); setFindOpen(true); setFilePanelOpen(false); });

  return {
    findOpen,
    findInitial,
    setFindOpen,
    setFindInitial,
  };
}
