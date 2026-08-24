"use client";

import { getTauriDesktop } from "./tauri-adapter";

export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface DesktopDialogFilter {
  name: string;
  extensions: string[];
}

export interface DesktopOpenDialogOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  filters?: DesktopDialogFilter[];
}

export interface DesktopSaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DesktopDialogFilter[];
}

export interface DesktopUpdateInfo {
  version: string;
  notes: string | null;
}

export interface FinworkDesktopBridge {
  platform: DesktopPlatform;
  workspaceAuthToken(): Promise<string>;
  openDialog(options?: DesktopOpenDialogOptions): Promise<string | string[] | null>;
  saveDialog(options?: DesktopSaveDialogOptions): Promise<string | null>;
  readFile(filePath: string): Promise<Uint8Array<ArrayBuffer>>;
  readTextFile(filePath: string): Promise<string>;
  openPath(target: string, application?: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setNativeTheme(theme: "light" | "dark" | "system"): Promise<void>;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    close(): Promise<void>;
    forceClose(): Promise<void>;
    setCloseGuard(enabled: boolean): Promise<void>;
    onMaximizedChanged(callback: (maximized: boolean) => void): () => void;
    onCloseRequested(callback: () => void): () => void;
  };
  updater: {
    check(): Promise<DesktopUpdateInfo | null>;
    download(onProgress: (progress: number) => void): Promise<void>;
    install(): Promise<void>;
  };
}

declare global {
  interface Window {
    finworkDesktop?: FinworkDesktopBridge;
  }
}

export function getDesktop(): FinworkDesktopBridge | null {
  return typeof window === "undefined" ? null : (window.finworkDesktop ?? getTauriDesktop());
}

export function isDesktop(): boolean {
  return getDesktop() !== null;
}

export function requireDesktop(): FinworkDesktopBridge {
  const desktop = getDesktop();
  if (!desktop) throw new Error("此操作需要 Finwork 桌面端");
  return desktop;
}

export async function workspaceAuthToken(): Promise<string> {
  return requireDesktop().workspaceAuthToken();
}
