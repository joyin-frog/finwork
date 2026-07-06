"use client";

import { getFileIcon } from "@/app/chat/chat-file-browser";
import { formatBytes } from "@/app/chat/chat-file-browser";
import type { StoredChatAttachment } from "@/lib/db/sqlite";

export function MentionPopup({
  files,
  selectedIndex,
  selectFile,
  setSelectedIndex
}: {
  files: StoredChatAttachment[];
  selectedIndex: number;
  selectFile: (file: StoredChatAttachment) => void;
  setSelectedIndex: (index: number) => void;
}) {
  return (
    <div className="mention-popup" role="listbox" aria-label="可引用文件">
      {files.length ? (
        files.map((file, index) => (
          <button
            key={file.id}
            className={index === selectedIndex ? "selected" : ""}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onClick={() => selectFile(file)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            {getFileIcon(file.mimeType, file.fileName)}
            <span>{file.fileName}</span>
            <small>{formatBytes(file.sizeBytes)}</small>
          </button>
        ))
      ) : (
        <div className="mention-empty">当前对话暂无可引用文件</div>
      )}
    </div>
  );
}
