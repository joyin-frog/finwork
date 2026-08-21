"use client";

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { readAttachment } from "@/app/chat/chat-request";
import type { ChatAttachment, ReferencedFile, GeneratedAttachment } from "@/app/chat/chat-types";
import type { StoredChatAttachment } from "@/lib/db/sqlite";

/**
 * 附件状态管理：草稿附件、引用附件、会话文件列表、生成文件。
 * 参数 ≤ 1，无 stale closure 风险（conversationId 通过参数传入，fetchConversationFiles 是内部函数）。
 * 文件面板自动弹开逻辑（shouldDefaultOpenFilePanel/shouldAutoOpenOutputPanel）仍由 chat-page.tsx 持有，
 * 依赖它手持的多个 ref，刻意不并入此 hook 以避免将 ref 作为参数注入造成耦合。
 *
 * @param conversationId 当前会话 ID（用于拉取会话文件）
 */
export function useAttachments({
  conversationId,
}: {
  conversationId: number | null;
}) {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [referencedAttachments, setReferencedAttachments] = useState<ReferencedFile[]>([]);
  const [conversationFiles, setConversationFiles] = useState<StoredChatAttachment[]>([]);
  const [conversationFilesLoaded, setConversationFilesLoaded] = useState(false);
  const [generatedFiles, setGeneratedFiles] = useState<Record<number, GeneratedAttachment[]>>({});
  const currentIdRef = useRef<number | null>(conversationId);

  async function fetchConversationFiles(id: number) {
    try {
      const res = await fetch(`/api/chat/attachments?conversationId=${id}`);
      const payload = (await res.json()) as { ok: boolean; data: { attachments: StoredChatAttachment[] } };
      if (currentIdRef.current !== null && currentIdRef.current !== id) return; // 陈旧响应：会话已切走
      if (payload.ok) setConversationFiles(payload.data.attachments);
    } catch {
      // File panel is helpful, not critical for chatting.
    } finally {
      if (currentIdRef.current === null || currentIdRef.current === id) {
        setConversationFilesLoaded(true);
      }
    }
  }

  // Consume pending attachments from knowledge page (sessionStorage)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("pendingChatAttachments");
      if (!raw) return;
      const pending = JSON.parse(raw) as ChatAttachment[];
      if (pending.length) {
        setAttachments(prev => [...prev, ...pending]);
      }
      sessionStorage.removeItem("pendingChatAttachments");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    currentIdRef.current = conversationId;
    if (conversationId) void fetchConversationFiles(conversationId);
  }, [conversationId]); // fetchConversationFiles is stable (defined inside hook, stable identity)

  async function addFiles(files: FileList | File[]) {
    const nextFiles = Array.from(files).filter((file) => {
      if (file.size > 50 * 1024 * 1024) {
        toast.error("文件超过 50MB 限制", { description: file.name });
        return false;
      }
      return true;
    });
    if (!nextFiles.length) return;
    try {
      const prepared = await Promise.all(nextFiles.map(readAttachment));
      setAttachments((current) => [...current, ...prepared]);
    } catch (error) {
      toast.error("文件添加失败", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  return {
    attachments,
    setAttachments,
    referencedAttachments,
    setReferencedAttachments,
    conversationFiles,
    setConversationFiles,
    conversationFilesLoaded,
    setConversationFilesLoaded,
    generatedFiles,
    setGeneratedFiles,
    addFiles,
    removeAttachment,
    fetchConversationFiles,
  };
}
