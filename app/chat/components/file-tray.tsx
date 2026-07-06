"use client";

import { AttachmentCard, ImageLightbox, useImageLightbox, isRenderableImage } from "@/app/chat/attachment-card";
import { formatBytes } from "@/app/chat/chat-file-browser";
import type { ChatAttachment, ReferencedFile } from "@/app/chat/chat-types";

export function FileTray({
  attachments,
  referencedAttachments,
  onPreviewAttachment,
  onPreviewReference,
  removeAttachment,
  removeReference
}: {
  attachments: ChatAttachment[];
  referencedAttachments: ReferencedFile[];
  onPreviewAttachment: (attachment: ChatAttachment) => void;
  onPreviewReference: (file: ReferencedFile) => void;
  removeAttachment: (id: string) => void;
  removeReference: (storagePath: string) => void;
}) {
  const { lightbox, openImage, closeImage } = useImageLightbox();
  if (!attachments.length && !referencedAttachments.length) return null;
  return (
    <div className="attachment-tray" aria-label="已添加文件">
      {attachments.map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          name={attachment.name}
          mimeType={attachment.mimeType}
          previewSrc={attachment.dataUrl}
          meta={attachment.size ? formatBytes(attachment.size) : undefined}
          // 图片点击直接看(lightbox),文件点击去预览页
          onOpen={() =>
            isRenderableImage(attachment.name, attachment.mimeType)
              ? openImage(attachment.dataUrl, attachment.name)
              : onPreviewAttachment(attachment)
          }
          onRemove={() => removeAttachment(attachment.id)}
        />
      ))}
      {referencedAttachments.map((file) => (
        <AttachmentCard
          key={file.storagePath}
          name={file.name}
          mimeType={file.mimeType}
          meta={file.sizeBytes ? formatBytes(file.sizeBytes) : undefined}
          onOpen={() => onPreviewReference(file)}
          onRemove={() => removeReference(file.storagePath)}
        />
      ))}
      {lightbox ? <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeImage} /> : null}
    </div>
  );
}
