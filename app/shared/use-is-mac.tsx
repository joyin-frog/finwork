"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { isMacLike } from "@/app/shared/shortcuts";

// 平台判定单例:在 AppShell 计算一次经 context 下发,
// 保证快捷键的"显示"(tooltip/一览表)与"匹配"(全局监听)永远同源同帧。

const IsMacContext = createContext<boolean | null>(null);

export function IsMacProvider({ children }: { children: React.ReactNode }) {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(isMacLike(navigator.userAgent));
  }, []);
  return <IsMacContext.Provider value={isMac}>{children}</IsMacContext.Provider>;
}

/** SSR 与 Provider 外兜底为 false(win 风格文字提示,不影响匹配正确性)。 */
export function useIsMac(): boolean {
  return useContext(IsMacContext) ?? false;
}
