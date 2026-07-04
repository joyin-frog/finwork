"use client";

/**
 * AttachmentCard — 统一尺寸的附件卡片(输入框草稿区与已发送消息共用)。
 * 参考 Claude:所有附件同宽同高、看起来协调。
 *  - 可渲染图片(png/jpg/webp/gif...):满卡预览,点击 → lightbox 直接查看(不去预览页);
 *  - 文件(含 HEIC 等浏览器不能渲染的图):文件语义色卡 + 文件名 + 格式徽章,点击 → 预览页。
 * 移除按钮仅在输入框草稿区出现(传 onRemove)。
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileTypeIcon } from "@/app/shared/file-type-icon";
import { FILE_TYPE_COLORS } from "@/lib/files/file-type-colors";

/** 浏览器能内联渲染的图片格式(HEIC/HEIF 不能 → 当文件卡处理)。 */
const RENDERABLE_IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isRenderableImage(name: string, mimeType: string): boolean {
  // HEIC/HEIF 浏览器一律解不了 → 当文件卡(mime 与文件名任一命中即判死,防两者不一致漏网)
  if (/heic|heif/i.test(mimeType) || /\.hei[cf]$/i.test(name)) return false;
  // 明确图片 mime:扩展名可渲染即可;无扩展名(纯图片 mime)也当图片
  if (mimeType.startsWith("image/")) return RENDERABLE_IMAGE.test(name) || !name.includes(".");
  // 无图片 mime:仅凭可渲染扩展名判定
  return RENDERABLE_IMAGE.test(name);
}

export function AttachmentCard({
  name,
  mimeType,
  previewSrc,
  meta,
  onOpen,
  onRemove,
}: {
  name: string;
  mimeType: string;
  /** 图片卡的图源(dataUrl 或会话文件 URL);文件卡不需要 */
  previewSrc?: string;
  /** 副信息,如 "49 行" / "12 KB"(文件卡显示在文件名下) */
  meta?: string;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const image = isRenderableImage(name, mimeType) && !!previewSrc;
  const ext = extOf(name);
  const fileColor = FILE_TYPE_COLORS[ext]?.color ?? "var(--muted-foreground)";
  const labelColor = FILE_TYPE_COLORS[ext]?.labelColor ?? "var(--muted-foreground)";

  return (
    <span className="attach-card" title={name}>
      <button
        type="button"
        className="attach-card-main"
        onClick={onOpen}
        aria-label={image ? `查看 ${name}` : `预览 ${name}`}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="attach-card-img" src={previewSrc} alt={name} loading="lazy" />
        ) : (
          <span className="attach-card-file" style={{ ["--file-color" as string]: fileColor }}>
            <span className="attach-card-name">{name}</span>
            {meta ? <span className="attach-card-meta">{meta}</span> : null}
            <span className="attach-card-badge" style={{ color: labelColor }}>
              <FileTypeIcon name={name} mimeType={mimeType} width={14} />
              {ext ? ext.toUpperCase() : "文件"}
            </span>
          </span>
        )}
      </button>
      {onRemove ? (
        <button type="button" className="attach-card-close" onClick={onRemove} aria-label={`移除 ${name}`}>
          &times;
        </button>
      ) : null}
    </span>
  );
}

/** 点击图片卡后的直接查看层:居中原图 + 深色遮罩,点空白/× / Esc 关闭。
 *  用 Portal 挂到 body:消息里的 lightbox 若留在 MessageScrollerItem(content-visibility/contain)
 *  内部,position:fixed 会相对该容器定位并被裁剪 → 必须逃出 containment 祖先。 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;
  return createPortal(
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <button type="button" className="image-lightbox-close" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="关闭">&times;</button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="image-lightbox-img" src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body
  );
}

/** 供父组件持有 lightbox 状态的小 hook。 */
export function useImageLightbox() {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const openImage = useCallback((src: string, alt: string) => setLightbox({ src, alt }), []);
  const closeImage = useCallback(() => setLightbox(null), []);
  return { lightbox, openImage, closeImage };
}
