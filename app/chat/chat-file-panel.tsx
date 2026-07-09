"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { PanelRightIcon, LayoutAlignRightIcon, AttachmentIcon } from "@hugeicons/core-free-icons";
import type { StoredChatAttachment } from "@/lib/db/sqlite";
import { FileGroup, type PreviewableConversationFile } from "@/app/chat/chat-file-browser";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";

export function ChatFilePanel({
  conversationId,
  files,
  filePanelOpen,
  onToggleFilePanel,
  openMenuKey,
  setOpenMenuKey,
  sidebarCollapsed,
  panelRightOffset,
  onToggleSidebar,
  onPreviewFile
}: {
  conversationId: number | null;
  files: StoredChatAttachment[];
  filePanelOpen: boolean;
  onToggleFilePanel: () => void;
  openMenuKey: string | null;
  setOpenMenuKey: (key: string | null) => void;
  sidebarCollapsed: boolean;
  panelRightOffset: number;
  onToggleSidebar: () => void;
  onPreviewFile: (file: PreviewableConversationFile) => void;
}) {
  const outputFiles = files.filter((file) => file.role === "assistant");
  const sourceFiles = files.filter((file) => file.role === "user");

  return (
    <div className="inline-flex items-center gap-2">
      <div className="relative">
        <ShortcutHint label={filePanelOpen ? "关闭文件面板" : "打开文件面板"} combo="mod+j">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleFilePanel}
            aria-label={filePanelOpen ? "关闭文件面板" : "打开文件面板"}
            aria-expanded={filePanelOpen}
          >
            <HugeiconsIcon icon={AttachmentIcon} size={16} />
          </Button>
        </ShortcutHint>
        {filePanelOpen ? (
          <Surface
            level="overlay"
            edge="none"
            shape="panel"
            className="fixed top-[46px] z-40 w-[340px] max-w-[calc(100vw-32px)] max-h-[min(60vh,560px)] overflow-x-hidden overflow-y-auto p-3.5"
            role="dialog"
            aria-label="文件面板"
            style={{ right: panelRightOffset }}
          >
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-meta">输出文件</strong>
                <span className="text-caption text-muted-foreground/60 tabular-nums">{outputFiles.length}</span>
              </div>
              {outputFiles.length ? (
                <FileGroup
                  title=""
                  files={outputFiles}
                  conversationId={conversationId}
                  openMenuKey={openMenuKey}
                  setOpenMenuKey={setOpenMenuKey}
                  showOpenWith={false}
                  onPreviewFile={onPreviewFile}
                />
              ) : (
                <div className="text-meta text-muted-foreground/60">暂无输出</div>
              )}
            </div>
            <div className="h-px my-4 bg-border" />
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-meta">来源文件</strong>
                <span className="text-caption text-muted-foreground/60 tabular-nums">{sourceFiles.length}</span>
              </div>
              {sourceFiles.length ? (
                <FileGroup
                  title=""
                  files={sourceFiles}
                  conversationId={conversationId}
                  openMenuKey={openMenuKey}
                  setOpenMenuKey={setOpenMenuKey}
                  showOpenWith={false}
                  onPreviewFile={onPreviewFile}
                />
              ) : (
                <div className="text-meta text-muted-foreground/60">暂无来源</div>
              )}
            </div>
          </Surface>
        ) : null}
      </div>
      {sidebarCollapsed ? (
        <ShortcutHint label="展开右侧栏" combo="alt+mod+b">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            aria-label="展开右侧栏"
            aria-expanded={false}
          >
            <HugeiconsIcon icon={LayoutAlignRightIcon} size={16} />
          </Button>
        </ShortcutHint>
      ) : null}
    </div>
  );
}
