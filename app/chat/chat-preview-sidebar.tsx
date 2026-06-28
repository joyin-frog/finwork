"use client";

import { FilePreviewPage, type PreviewFileSelection } from "@/app/shared/file-preview-page";

export function ChatPreviewSidebar({
  collapsed,
  width,
  previewSelection,
  onMaximize,
  isMaximized
}: {
  collapsed: boolean;
  width: number;
  previewSelection: PreviewFileSelection | null;
  onMaximize?: () => void;
  isMaximized?: boolean;
}) {
  if (collapsed) return null;
  return (
    <aside className="context-sidebar preview-sidebar" style={{ width, minWidth: 0, flexShrink: 0 }}>
      <FilePreviewPage selection={previewSelection} onSelectionChange={() => undefined} onMaximize={onMaximize} isMaximized={isMaximized} docked />
    </aside>
  );
}
