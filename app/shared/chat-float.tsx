"use client";

/**
 * chat-float.tsx — 对话浮窗（D1 切片）
 *
 * - 右下角固定圆钮（/chat 路径下隐藏）
 * - 小窗约 400×560：输入 + 轻量流式回显
 * - 放大按钮：conversationId 有 → /chat/recent?id=，无 → /chat/new?prompt=
 * - 安全红线：检测 ask_user → 自动升全屏
 * - 监听 CustomEvent "chat-float:open"：detail.text 预填并打开小窗
 *
 * 阶段一不渲染工具卡/确认门/文件预览（阶段二范围）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageAdd01Icon, ArrowExpand01Icon, Cancel01Icon, ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { MarkdownMessage } from "@/app/chat/markdown-message";
import { useChatStream } from "@/app/shared/chat-stream";
import type { StartTurnParams } from "@/app/shared/chat-stream";
import type { DisplayFile, Message } from "@/app/chat/chat-types";

// ─── 空数组常量（MarkdownMessage 不需要文件列表时的占位） ────────────────────
const EMPTY_FILES: DisplayFile[] = [];
function noop() {}

// ─── ChatFloat ───────────────────────────────────────────────────────────────

export function ChatFloat() {
  const pathname = usePathname();
  const router = useRouter();
  const { startTurn, getTurn } = useChatStream();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [turnKey, setTurnKey] = useState<string | null>(null);
  // 本地历史:每轮 key 都不同(见 handleSend),turn store 里的对象只装当前这一轮,
  // 不接住就会在下一句发出去的瞬间从界面消失——history 负责把已完成的轮次留住。
  const [history, setHistory] = useState<Message[]>([]);
  const capturedKeyRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const turn = getTurn(turnKey);
  const conversationId = turn?.conversationId ?? null;
  const isStreaming = turn?.status === "streaming";

  // 回合结束(done)后并入本地历史,每个 turnKey 只并入一次
  useEffect(() => {
    if (!turn || !turnKey || turn.status !== "done") return;
    if (capturedKeyRef.current === turnKey) return;
    capturedKeyRef.current = turnKey;
    setHistory((prev) => [
      ...prev,
      turn.userMessage,
      { role: "assistant", content: turn.streamedContent || "（无内容）" },
    ]);
  }, [turn, turnKey]);

  // ─── A7: /chat 路径下圆钮隐藏 ───────────────────────────────────────────
  const isOnChat = pathname.startsWith("/chat");

  // ─── A4: timeline 中检测未配对的 ask_user → 升全屏 ──────────────────────
  useEffect(() => {
    if (!turn) return;
    const timeline = turn.timeline;
    if (!timeline || timeline.length === 0) return;

    // 照抄 chat-page.tsx:214-222 的配对逻辑
    const answered = new Set<string>();
    for (const t of timeline) {
      if (t.event.type === "ask_user_answered") answered.add(t.event.questionId);
    }
    for (let i = timeline.length - 1; i >= 0; i--) {
      const e = timeline[i].event;
      if (e.type === "ask_user" && !answered.has(e.questionId)) {
        // 有未配对的 ask_user → 升全屏
        const cid = turn.conversationId;
        setOpen(false);
        router.push(cid ? `/chat/recent?id=${cid}` : "/chat/new");
        return;
      }
    }
  }, [turn, router]);

  // ─── A5: 监听 CustomEvent "chat-float:open" ──────────────────────────────
  useEffect(() => {
    function handleOpen(e: Event) {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      if (detail?.text) {
        setDraft(detail.text);
      }
      setOpen(true);
      // 聚焦输入框
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
    window.addEventListener("chat-float:open", handleOpen);
    return () => window.removeEventListener("chat-float:open", handleOpen);
  }, []);

  // ─── 发送 ────────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || isStreaming) return;

    const key = `float:${crypto.randomUUID()}`;
    const userMessage: Message = { role: "user", content: text };

    const params: StartTurnParams = {
      key,
      conversationId: conversationId,
      userMessage,
      baseMessages: history,
      requestMessages: [...history, userMessage],
      attachments: [],
      referencedAttachments: [],
    };

    setDraft("");
    setTurnKey(key);
    startTurn(params);
  }, [draft, isStreaming, conversationId, startTurn, history]);

  // ─── A6: 放大按钮双分支 ──────────────────────────────────────────────────
  function handleExpand() {
    if (conversationId) {
      router.push(`/chat/recent?id=${conversationId}`);
    } else {
      router.push(`/chat/new?prompt=${encodeURIComponent(draft)}`);
    }
    setOpen(false);
  }

  // ─── 组装助手回显文本 ────────────────────────────────────────────────────
  const assistantContent = turn?.streamedContent ?? "";
  const userContent = turn?.userMessage.content ?? "";
  // 当前轮一旦被并入 history(effect 里发生),这里不再重复渲染,避免同一轮闪现两次
  const showLiveTurn = turn != null && capturedKeyRef.current !== turnKey;

  // ─── 渲染 ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* 圆钮：/chat 下隐藏 */}
      {!isOnChat && (
        <button
          type="button"
          aria-label="打开对话浮窗"
          onClick={() => setOpen((v) => !v)}
          className="fixed bottom-5 right-5 z-50 flex items-center justify-center w-11 h-11 rounded-full bg-primary text-primary-foreground shadow-[var(--elevation-2)] hover:opacity-90 transition-opacity"
        >
          <HugeiconsIcon icon={MessageAdd01Icon} size={20} />
        </button>
      )}

      {/* 小窗 */}
      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="对话浮窗"
          className="fixed bottom-20 right-5 z-50 flex flex-col w-[400px] h-[560px] rounded-xl border border-border bg-card shadow-[var(--elevation-3)] overflow-hidden"
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="text-body font-medium text-foreground">对话</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="放大到全屏"
                onClick={handleExpand}
                className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon icon={ArrowExpand01Icon} size={14} />
              </button>
              <button
                type="button"
                aria-label="关闭浮窗"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} />
              </button>
            </div>
          </div>

          {/* 消息区 */}
          <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 min-h-0">
            {/* 历史消息(已完成的往轮,不然发下一句时会从界面消失) */}
            {history.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-body text-primary-foreground whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[90%] text-body md-content">
                    <MarkdownMessage content={m.content} conversationId={conversationId} files={EMPTY_FILES} onPreviewFile={noop} />
                  </div>
                </div>
              )
            )}

            {/* 当前这一轮(用户气泡) */}
            {showLiveTurn && userContent && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-body text-primary-foreground whitespace-pre-wrap break-words">
                  {userContent}
                </div>
              </div>
            )}

            {/* 助手回显 */}
            {showLiveTurn && (assistantContent || isStreaming) && (
              <div className="flex justify-start">
                <div className="max-w-[90%] text-body md-content">
                  {isStreaming && !assistantContent ? (
                    <span className="text-muted-foreground animate-pulse">正在处理…</span>
                  ) : (
                    <MarkdownMessage
                      content={assistantContent}
                      conversationId={conversationId}
                      files={EMPTY_FILES}
                      onPreviewFile={noop}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 输入区 */}
          <div className="shrink-0 border-t border-border px-3 py-2 flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="有什么财务问题？（Enter 发送）"
              rows={2}
              className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="对话输入"
            />
            <button
              type="button"
              aria-label="发送"
              disabled={!draft.trim() || isStreaming}
              onClick={handleSend}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground disabled:opacity-40 transition-opacity shrink-0"
            >
              <HugeiconsIcon icon={ArrowUp02Icon} size={15} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
