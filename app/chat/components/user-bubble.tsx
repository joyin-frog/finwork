"use client";

import { AttachmentCard, ImageLightbox, useImageLightbox, isRenderableImage } from "@/app/chat/attachment-card";
import {
  formatBytes,
  getConversationFileUrl,
  type PreviewableConversationFile
} from "@/app/chat/chat-file-browser";
import { MarkdownMessage } from "@/app/chat/markdown-message";
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
}: {
  message: Message;
  files: DisplayFile[];
  conversationId: number | null;
  onPreviewDisplayFile: (file: DisplayFile) => void;
  onPreviewFile: (file: PreviewableConversationFile) => void;
}) {
  const { lightbox, openImage, closeImage } = useImageLightbox();
  // 无对应 DisplayFile 的遗留 imageDataUrls(仅在没有 files 时兜底展示)
  const legacyImages = files.length ? [] : (message.imageDataUrls ?? []);
  const hasAttachments = files.length > 0 || legacyImages.length > 0;
  return (
    <div className="flex flex-col items-end gap-2 max-w-[85%]">
      {/* 附件统一成同尺寸卡片,置于消息上方(参考 Claude);图片点击直接看,文件点击去预览页 */}
      {hasAttachments ? (
        <div className="flex flex-wrap gap-2 justify-end">
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
      {message.content.trim() ? (
        <div className={cn(surfaceVariants({ level: "page", edge: "none", shape: "overlay" }), "md-content bg-primary/8 px-4 py-2")}>
          <MarkdownMessage content={getDisplayContent(message)} conversationId={conversationId} files={files} onPreviewFile={onPreviewFile} />
        </div>
      ) : null}
      {lightbox ? <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeImage} /> : null}
    </div>
  );
}
