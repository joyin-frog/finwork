"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Folder02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { StoredChatAttachment } from "@/lib/db/sqlite";
import { FileTypeIcon } from "@/app/shared/file-type-icon";

type OpenWithApp = {
  name: string;
  path: string;
  iconUrl?: string;
};

export type PreviewableConversationFile = Pick<
  StoredChatAttachment,
  "fileName" | "mimeType" | "sizeBytes" | "storagePath"
> & { id?: string };

export function FileGroup({
  title,
  files,
  conversationId,
  openMenuKey,
  setOpenMenuKey,
  onPreviewFile,
  showOpenWith = true
}: {
  title: string;
  files: StoredChatAttachment[];
  conversationId: number | null;
  openMenuKey: string | null;
  setOpenMenuKey: (key: string | null) => void;
  onPreviewFile: (file: PreviewableConversationFile) => void;
  showOpenWith?: boolean;
}) {
  return (
    // min-w-0:作为外层 grid 列的子项,默认 min-width:auto=min-content 会被长文件名撑宽、
    // 把 truncate 顶失效(整行超出面板被裁却没省略号);置 0 才能收缩到列宽内、让文件名省略生效。
    <div className="file-group min-w-0">
      {title ? <h3>{title}</h3> : null}
      {files.length ? (
        files.map((file) => (
          <OpenableFileRow
            key={file.id}
            menuKey={`sidebar-${file.id}`}
            attachmentId={file.id}
            conversationId={conversationId}
            name={file.fileName}
            mimeType={file.mimeType}
            sizeBytes={file.sizeBytes}
            storagePath={file.storagePath}
            compact
            openMenuKey={openMenuKey}
            setOpenMenuKey={setOpenMenuKey}
            onPreviewFile={onPreviewFile}
            showOpenWith={showOpenWith}
          />
        ))
      ) : (
        <p className="file-empty">暂无文件</p>
      )}
    </div>
  );
}

export function OpenableFileRow({
  menuKey,
  attachmentId,
  conversationId,
  name,
  mimeType,
  sizeBytes,
  storagePath,
  openMenuKey,
  setOpenMenuKey,
  compact,
  bordered,
  onPreviewFile,
  showOpenWith = true
}: {
  menuKey: string;
  /** 会话附件 id;给定时多一个「加入知识库」入口(只有真正落库的附件才有 id,内联产物没有)。 */
  attachmentId?: string;
  conversationId: number | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath?: string;
  openMenuKey: string | null;
  setOpenMenuKey: (key: string | null) => void;
  compact?: boolean;
  /** 卡片化:加边框+底色,用于对话气泡里的产物文件,便于和正文区分。 */
  bordered?: boolean;
  onPreviewFile?: (file: PreviewableConversationFile) => void;
  showOpenWith?: boolean;
}) {
  const menuOpen = openMenuKey === menuKey;
  const [apps, setApps] = useState<OpenWithApp[] | null>(null);
  const [loadingApps, setLoadingApps] = useState(false);
  const disabled = !storagePath || !conversationId;

  function openDefault() {
    if (!storagePath) return;
    if (onPreviewFile) {
      // 把附件 id 一并带进预览选择,预览页才能提供「加入知识库」(只有落库附件有 id)。
      onPreviewFile({ id: attachmentId, fileName: name, mimeType, sizeBytes, storagePath });
      return;
    }
    void openConversationFile(conversationId, storagePath, mimeType);
  }

  function openWith(appPath: string) {
    if (!storagePath) return;
    setOpenMenuKey(null);
    void openConversationFile(conversationId, storagePath, mimeType, appPath);
  }

  function reveal() {
    if (!storagePath) return;
    setOpenMenuKey(null);
    void revealConversationFile(conversationId, storagePath);
  }

  function handleMenuOpenChange(open: boolean) {
    setOpenMenuKey(open ? menuKey : null);
    if (!open || apps || loadingApps) return;
    void loadApps();
  }

  async function loadApps() {
    setLoadingApps(true);
    try {
      const params = new URLSearchParams({ name, mimeType });
      const response = await fetch(`/api/open-with/apps?${params.toString()}`);
      const payload = (await response.json()) as { ok: boolean; data?: { apps: OpenWithApp[] } };
      setApps(payload.ok ? payload.data?.apps ?? [] : []);
    } catch {
      setApps([]);
    } finally {
      setLoadingApps(false);
    }
  }

  return (
    <div className={cn(
      "flex min-w-0 items-center gap-1",
      compact ? "py-0.5" : "py-1",
      bordered && "rounded-lg border border-border bg-card px-1.5 py-1"
    )}>
      <button
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
        onClick={openDefault}
        type="button"
        title={`打开 ${name}`}
        disabled={disabled}
      >
        {getFileIcon(mimeType, name)}
        <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">{name}</span>
      </button>
      {showOpenWith ? (
        <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="shrink-0 gap-1 text-muted-foreground" disabled={disabled}>
              打开方式
              <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {loadingApps ? (
              <div className="px-2 py-1.5 text-meta text-muted-foreground">正在查找可打开的应用...</div>
            ) : null}
            {!loadingApps && !apps?.length ? (
              <div className="px-2 py-1.5 text-meta text-muted-foreground">未找到匹配应用，可用默认应用打开</div>
            ) : null}
            {(apps ?? []).map((app) => (
              <DropdownMenuItem key={`${app.name}-${app.path}`} onSelect={() => openWith(app.path)}>
                {app.iconUrl ? (
                  <img className="size-4 shrink-0 object-contain" src={app.iconUrl} alt="" loading="lazy" />
                ) : (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-caption">
                    {getAppGlyph(app.name)}
                  </span>
                )}
                <span className="truncate">{app.name}</span>
              </DropdownMenuItem>
            ))}
            {apps?.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={reveal}>
              <HugeiconsIcon icon={Folder02Icon} className="size-4" />
              在文件夹中显示
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function getFileIcon(mimeType: string, name = "") {
  return <FileTypeIcon mimeType={mimeType} name={name} />;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function isImageFile(mimeType: string) {
  return mimeType.startsWith("image/");
}

export function getConversationFileUrl(conversationId: number, storagePath: string) {
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  return `${window.location.origin}/api/files/${conversationId}/${encoded}`;
}

function getAppGlyph(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("code")) return "C";
  if (lower.includes("excel") || lower.includes("numbers")) return "X";
  if (lower.includes("word")) return "W";
  if (lower.includes("powerpoint")) return "P";
  if (lower.includes("terminal")) return ">";
  if (lower.includes("finder") || lower.includes("default")) return "D";
  return name.slice(0, 1).toUpperCase();
}


async function openConversationFile(conversationId: number | null, storagePath: string, mimeType?: string, appPath?: string) {
  if (!conversationId) return;
  const fileUrl = getConversationFileUrl(conversationId, storagePath);
  if (mimeType && isImageFile(mimeType) && appPath === undefined) {
    window.open(fileUrl, "_blank");
    return;
  }
  try {
    const appQuery = appPath !== undefined ? `&app=${encodeURIComponent(appPath)}` : "";
    const response = await fetch(`${fileUrl}?action=open${appQuery}`);
    if (!response.ok) throw new Error("open failed");
  } catch {
    window.open(fileUrl, "_blank");
  }
}

async function revealConversationFile(conversationId: number | null, storagePath: string) {
  if (!conversationId) return;
  const fileUrl = getConversationFileUrl(conversationId, storagePath);
  try {
    const response = await fetch(`${fileUrl}?action=reveal`);
    if (!response.ok) throw new Error("reveal failed");
  } catch {
    window.open(fileUrl, "_blank");
  }
}
