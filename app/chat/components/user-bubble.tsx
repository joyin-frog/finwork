"use client";

import { useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Undo03Icon } from "@hugeicons/core-free-icons";
import { CopyIcon, SuccessIcon } from "@/lib/icons";
import { messageTimestamp } from "@/app/chat/message-timestamp";
import { AttachmentCard, ImageLightbox, useImageLightbox, isRenderableImage } from "@/app/chat/attachment-card";
import { FolderCard, openLocalFolder } from "@/app/chat/folder-card";
import {
  formatBytes,
  getConversationFileUrl,
  type PreviewableConversationFile
} from "@/app/chat/chat-file-browser";
import { MarkdownMessage } from "@/app/chat/markdown-message";
import { splitFolderPathLines } from "@/app/chat/folder-path";
import type { Message, DisplayFile } from "@/app/chat/chat-types";
import { getDisplayContent } from "./assistant-turn";
import { surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

export function UserBubble({
  message,
  files,
  conversationId,
  onPreviewDisplayFile,
  onPreviewFile,
  onRetract,
  retractDisabled,
}: {
  message: Message;
  files: DisplayFile[];
  conversationId: number | null;
  onPreviewDisplayFile: (file: DisplayFile) => void;
  onPreviewFile: (file: PreviewableConversationFile) => void;
  onRetract?: () => void;
  retractDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const { lightbox, openImage, closeImage } = useImageLightbox();
  // 无对应 DisplayFile 的遗留 imageDataUrls(仅在没有 files 时兜底展示)
  const legacyImages = files.length ? [] : (message.imageDataUrls ?? []);
  const { folders } = splitFolderPathLines(message.content);
  const displayText = getDisplayContent(message);
  const hasAttachments = files.length > 0 || legacyImages.length > 0 || folders.length > 0;

  async function copyMessage() {
    const text = getDisplayContent(message);
    if (!text.trim() && !folders.length) return;
    const copyText = [text.trim(), ...folders.map((f) => f.path)].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      toast.success("已复制");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败,请重试");
    }
  }

  return (
    <div className="group flex flex-col items-end gap-2 max-w-[85%]">
      {/* 附件统一成同尺寸卡片,置于消息上方(参考 Claude);图片点击直接看,文件点击去预览页 */}
      {hasAttachments ? (
        <div className="flex flex-wrap gap-2 justify-end">
          {folders.map((folder) => (
            <FolderCard
              key={folder.path}
              name={folder.name}
              path={folder.path}
              onOpen={() => void openLocalFolder(folder.path)}
            />
          ))}
          {files.map((file) => {
            const src = file.dataUrl ?? (file.storagePath && conversationId ? getConversationFileUrl(conversationId, file.storagePath) : "");
            return (
              <AttachmentCard
                key={`${file.name}-${file.storagePath ?? file.id ?? ""}`}
                name={file.name}
                mimeType={file.mimeType}
                previewSrc={src || undefined}
                meta={file.sizeBytes ? formatBytes(file.sizeBytes) : undefined}
                onOpen={() =>
                  isRenderableImage(file.name, file.mimeType) && src
                    ? openImage(src, file.name)
                    : onPreviewDisplayFile(file)
                }
              />
            );
          })}
          {legacyImages.map((url, index) => (
            <AttachmentCard
              key={url}
              name={`附件图片 ${index + 1}`}
              mimeType="image/png"
              previewSrc={url}
              onOpen={() => openImage(url, `附件图片 ${index + 1}`)}
            />
          ))}
        </div>
      ) : null}
      {displayText.trim() ? (
        <div className={cn(surfaceVariants({ level: "page", edge: "none", shape: "overlay" }), "md-content bg-muted px-4 py-2 dark:bg-sidebar")}>
          <MarkdownMessage content={displayText} conversationId={conversationId} files={files} onPreviewFile={onPreviewFile} />
        </div>
      ) : null}
      {lightbox ? <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeImage} /> : null}
      {/* 消息工具条：hover / 焦点才淡入；流式未返回时不渲染撤回（避免 disabled:opacity 压过隐藏）。 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cn(
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            "flex items-center gap-1 px-2 py-1 rounded text-meta transition-colors transition-opacity",
            copied
              ? "text-[color:var(--tone-ok)] bg-[color:var(--tone-ok)]/10"
              : "msg-toolbar-btn-fade text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground hover:bg-muted"
          )}
          aria-label={copied ? "已复制" : "复制"}
          onClick={() => void copyMessage()}
        >
          <HugeiconsIcon icon={copied ? SuccessIcon : CopyIcon} size={13} />
        </button>
        {onRetract && !retractDisabled ? (
          <button
            type="button"
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            className="msg-toolbar-btn-fade flex items-center gap-1 px-2 py-1 rounded text-meta text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-colors transition-opacity hover:text-foreground hover:bg-muted"
            aria-label="撤回到输入框"
            onClick={onRetract}
          >
            <HugeiconsIcon icon={Undo03Icon} size={13} />
          </button>
        ) : null}
        {message.createdAt ? (
          <span className="msg-toolbar-timestamp text-caption text-muted-foreground/60 px-1 select-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            {messageTimestamp(message.createdAt)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
