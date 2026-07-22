"use client";

/**
 * 文件夹专属附件卡:与 AttachmentCard 同尺寸,点一下用系统文件管理器打开目录。
 * 桌面壳优先走 Tauri shell;浏览器/dev 回退 POST /api/local/open-folder。
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";

/** Finder / 资源管理器里文件夹的常见琥珀色,作卡片语义色。 */
const FOLDER_COLOR = "#E8A317";
const FOLDER_LABEL = "#C9921A";

export function FolderCard({
  name,
  path,
  onOpen,
  onRemove,
}: {
  name: string;
  path: string;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  return (
    <span className="attach-card" title={path}>
      <button type="button" className="attach-card-main" onClick={onOpen} aria-label={`打开文件夹 ${name}`}>
        <span className="attach-card-file" style={{ ["--file-color" as string]: FOLDER_COLOR }}>
          <span className="attach-card-name">{name}</span>
          <span className="attach-card-meta">本地文件夹</span>
          <span className="attach-card-badge" style={{ color: FOLDER_LABEL }}>
            <HugeiconsIcon icon={Folder01Icon} size={14} />
            文件夹
          </span>
        </span>
      </button>
      {onRemove ? (
        <button type="button" className="attach-card-close" onClick={onRemove} aria-label={`移除 ${name}`}>
          &times;
        </button>
      ) : null}
    </span>
  );
}

/** 打开本地文件夹:Tauri → shell.open;否则走本机 Next API。 */
export async function openLocalFolder(folderPath: string) {
  const path = folderPath.trim();
  if (!path) return;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(path);
      return;
    } catch (err) {
      console.error("[open-folder] tauri open failed", err);
    }
  }
  try {
    const res = await fetch("/api/local/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("[open-folder] failed", err);
    toast.error("无法打开文件夹");
  }
}
