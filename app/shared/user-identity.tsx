"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

/** 侧栏底部头像行要展示的用户身份;单一源,设置页改完即时同步到侧栏(setIdentity)。 */
type UserIdentity = { name: string; avatar: string };

type UserIdentityState = UserIdentity & {
  /** 首次拉取完成前为 false,用于避免闪烁占位 */
  ready: boolean;
  /** 设置页保存后即时更新侧栏(乐观),持久化由设置页各自的落库负责 */
  setIdentity: (next: UserIdentity) => void;
};

const UserIdentityContext = createContext<UserIdentityState | null>(null);

export function useUserIdentity() {
  const ctx = useContext(UserIdentityContext);
  if (!ctx) throw new Error("useUserIdentity must be used within UserIdentityProvider");
  return ctx;
}

export function UserIdentityProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [ready, setReady] = useState(false);

  // 挂载时拉一次:侧栏无需打开设置也要有名字/头像。
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings/claude");
        const payload = (await res.json()) as { ok: boolean; data?: { userName?: string; userAvatar?: string } };
        if (payload.ok && payload.data) {
          setName(payload.data.userName ?? "");
          setAvatar(payload.data.userAvatar ?? "");
        }
      } catch {
        // best-effort:失败就用空,头像行退到姓名首字/默认
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const value = useMemo<UserIdentityState>(
    () => ({
      name,
      avatar,
      ready,
      setIdentity: (next) => { setName(next.name); setAvatar(next.avatar); },
    }),
    [name, avatar, ready]
  );

  return <UserIdentityContext.Provider value={value}>{children}</UserIdentityContext.Provider>;
}
