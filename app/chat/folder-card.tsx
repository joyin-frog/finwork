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

/** 打开本地文件夹:桌面桥 → 系统 shell;否则走本机 Next API。 */
export async function openLocalFolder(folderPath: string) {
  const path = folderPath.trim();
  if (!path) return;
  const { getDesktop } = await import("@/lib/desktop/client");
  const desktop = getDesktop();
  if (desktop) {
    try {
      await desktop.openPath(path);
      return;
    } catch (err) {
      console.error("[open-folder] desktop open failed", err);
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

/** 历史消息只保留 rootId；需要打开时由桌面令牌临时解析真实路径。 */
export async function openWorkspaceRoot(rootId: string) {
  const { getDesktop, workspaceAuthToken } = await import("@/lib/desktop/client");
  const desktop = getDesktop();
  if (!rootId || !desktop) {
    toast.error("这个文件夹需要在 Finwork 桌面端打开");
    return;
  }
  try {
    const token = await workspaceAuthToken();
    const response = await fetch(`/api/workspace/roots/${encodeURIComponent(rootId)}/reveal`, {
      headers: { "x-finwork-workspace-auth": token },
    });
    const payload = await response.json() as { ok?: boolean; data?: { path?: string }; error?: string };
    if (!response.ok || !payload.data?.path) throw new Error(payload.error ?? "文件夹授权已失效");
    await desktop.openPath(payload.data.path);
  } catch (error) {
    console.error("[open-workspace-root] failed", error);
    toast.error("无法打开文件夹");
  }
}
