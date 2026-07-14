"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { LayoutAlignRightIcon, AttachmentIcon } from "@hugeicons/core-free-icons";
import type { StoredChatAttachment } from "@/lib/db/sqlite";
import { FileGroup, type PreviewableConversationFile } from "@/app/chat/chat-file-browser";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

export function ChatFilePanel({
  conversationId,
  files,
  filePanelOpen,
  onToggleFilePanel,
  openMenuKey,
  setOpenMenuKey,
  sidebarCollapsed,
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
  onToggleSidebar: () => void;
  onPreviewFile: (file: PreviewableConversationFile) => void;
}) {
  const outputFiles = files.filter((file) => file.role === "assistant");
  const sourceFiles = files.filter((file) => file.role === "user");

  return (
    <Popover
      open={filePanelOpen}
      onOpenChange={(open) => {
        // 仅当 Radix 期望的状态与当前不同时才 toggle，避免双触发
        if (open !== filePanelOpen) onToggleFilePanel();
      }}
    >
      {/* 锚点 = 整个按钮簇容器（右缘恒等于标题栏内容右缘，不随预览开合/是否有展开按钮而变），
          让面板始终相对「主内容右缘」定位，而非相对附件按钮（附件按钮右侧还有展开按钮时会偏） */}
      <PopoverAnchor asChild>
        <div className="inline-flex items-center gap-2">
          {/* ShortcutHint 在外层：TooltipTrigger asChild → PopoverTrigger asChild → Button，
              Radix Slot 链从内到外合并所有事件处理器到叶子 Button，popover onClick 正确到达 */}
          <ShortcutHint label={filePanelOpen ? "关闭文件面板" : "打开文件面板"} combo="mod+j">
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={filePanelOpen ? "关闭文件面板" : "打开文件面板"}
                aria-expanded={filePanelOpen}
              >
                <HugeiconsIcon icon={AttachmentIcon} size={16} />
              </Button>
            </PopoverTrigger>
          </ShortcutHint>
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
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        alignOffset={-15}
        className="w-max min-w-[170px] max-w-[min(340px,calc(100vw-32px))] max-h-[min(60vh,560px)] overflow-x-hidden overflow-y-auto p-3.5"
        role="dialog"
        aria-label="文件面板"
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
        </PopoverContent>
      </Popover>
  );
}
