"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type UsageWindow = { pct: number; resetAt: number };
export type UsageData = {
  enabled: boolean;
  blocked?: boolean;
  fivehour?: UsageWindow;
  week?: UsageWindow;
};

const POLL_MS = 60_000;

/**
 * 拉 /api/usage 驱动用量进度环:挂载即取 + 周期轮询,并暴露 refetch(回合结束后刷新)。
 * 非关键路径:任何失败静默,不影响聊天。
 */
export function useUsage(pollMs = POLL_MS): { usage: UsageData | null; refetch: () => void } {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const aliveRef = useRef(true);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      if (!res.ok) return;
      const json = (await res.json()) as { ok?: boolean; data?: UsageData };
      if (aliveRef.current && json?.ok && json.data) setUsage(json.data);
    } catch {
      /* 用量环非关键,忽略 */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void fetchUsage();
    const id = setInterval(() => void fetchUsage(), pollMs);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [fetchUsage, pollMs]);

  return { usage, refetch: fetchUsage };
}
