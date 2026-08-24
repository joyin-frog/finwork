"use client";

import type { FinworkDesktopBridge } from "./client";

type LegacyUpdate = {
  version: string;
  body?: string;
  download(onEvent?: (event: { event: "Started" | "Progress" | "Finished"; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
};

let bridge: FinworkDesktopBridge | null = null;
let closeGuardEnabled = false;
let selectedUpdate: LegacyUpdate | null = null;

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function platform(): FinworkDesktopBridge["platform"] {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("windows")) return "win32";
  if (userAgent.includes("macintosh") || userAgent.includes("mac os")) return "darwin";
  return "linux";
}

function deferredSubscription(register: () => Promise<() => void>): () => void {
  let active = true;
  let unlisten: (() => void) | undefined;
  void register().then((registered) => {
    if (active) unlisten = registered;
    else registered();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

export function getTauriDesktop(): FinworkDesktopBridge | null {
  if (!isTauriRuntime()) return null;
  bridge ??= {
    platform: platform(),
    workspaceAuthToken: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("workspace_auth_token");
    },
    openDialog: async (options = {}) => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return open(options);
    },
    saveDialog: async (options = {}) => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return save(options);
    },
    readFile: async (filePath) => {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      return readFile(filePath);
    },
    readTextFile: async (filePath) => {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      return readTextFile(filePath);
    },
    openPath: async (target) => {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(target);
    },
    openExternal: async (url) => {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    },
    window: {
      minimize: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().minimize(),
      toggleMaximize: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().toggleMaximize(),
      isMaximized: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().isMaximized(),
      close: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().close(),
      forceClose: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().destroy(),
      setCloseGuard: async (enabled) => {
        closeGuardEnabled = enabled;
      },
      onMaximizedChanged: (callback) => deferredSubscription(async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const current = getCurrentWindow();
        return current.onResized(async () => callback(await current.isMaximized()));
      }),
      onCloseRequested: (callback) => deferredSubscription(async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        return getCurrentWindow().onCloseRequested((event) => {
          if (!closeGuardEnabled) return;
          event.preventDefault();
          callback();
        });
      }),
    },
    updater: {
      check: async () => {
        await selectedUpdate?.close();
        const { check } = await import("@tauri-apps/plugin-updater");
        selectedUpdate = await check() as LegacyUpdate | null;
        return selectedUpdate ? { version: selectedUpdate.version, notes: selectedUpdate.body ?? null } : null;
      },
      download: async (onProgress) => {
        if (!selectedUpdate) throw new Error("请先检查更新");
        let downloaded = 0;
        let total = 0;
        await selectedUpdate.download((event) => {
          if (event.event === "Started") total = event.data?.contentLength ?? 0;
          else if (event.event === "Progress") {
            downloaded += event.data?.chunkLength ?? 0;
            if (total > 0) onProgress(Math.min(100, Math.round((downloaded / total) * 100)));
          } else if (event.event === "Finished") onProgress(100);
        });
      },
      install: async () => {
        if (!selectedUpdate) throw new Error("没有可安装的更新");
        await selectedUpdate.install();
      },
    },
  };
  return bridge;
}
