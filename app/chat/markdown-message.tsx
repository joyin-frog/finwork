"use client";

/**
 * MarkdownMessage — 共享模块（D1 切片抽取自 chat-page.tsx）
 *
 * 同时被 chat-page.tsx 与 chat-float.tsx 引用，单一实现，禁止内联重写。
 */

import { Children, isValidElement, memo, useDeferredValue, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { REHYPE_PLUGINS } from "@/app/chat/markdown-rehype-config";
import { HugeiconsIcon } from "@hugeicons/react";
import { InternetIcon } from "@hugeicons/core-free-icons";
import { SuccessIcon, CopyIcon } from "@/lib/icons";
import { remarkFinanceFileLinks } from "@/lib/remark/finance-file-links";
import { parseCodeLanguage } from "@/app/chat/code-language";
import { parseFileLinkHref, normalizeModelFileLinks } from "@/app/chat/chat-preview-selection";
import { getFileIcon } from "@/app/chat/chat-file-browser";
import type { DisplayFile } from "@/app/chat/chat-types";
import type { PreviewableConversationFile } from "@/app/chat/chat-file-browser";
import type { PluggableList } from "unified";
import { openExternalUrl } from "@/app/chat/external-link";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 从 ReactMarkdown <pre> 子 <code class="language-xxx"> 上取语言名。 */
function extractCodeLanguage(children: React.ReactNode): string | null {
  const first = Children.toArray(children)[0];
  if (!isValidElement(first)) return null;
  return parseCodeLanguage((first.props as { className?: string }).className);
}

export function guessMimeType(fileName: string) {
  const ext = fileName.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json"
  };
  return ext ? map[ext] ?? "application/octet-stream" : "application/octet-stream";
}

// ─── CodeBlock ───────────────────────────────────────────────────────────────

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = extractCodeLanguage(children);
  async function copy() {
    const text = ref.current?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  }
  return (
    <div className="relative group">
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {language ? (
          <span className="font-mono text-caption uppercase tracking-wide text-muted-foreground select-none">{language}</span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center justify-center rounded p-1 bg-muted/80 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
          aria-label={copied ? "已复制" : "复制代码"}
        >
          <HugeiconsIcon icon={copied ? SuccessIcon : CopyIcon} size={13} />
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

// ─── TableBlock ──────────────────────────────────────────────────────────────

function tableToText(table: HTMLTableElement | null): string {
  if (!table) return "";
  return Array.from(table.querySelectorAll("tr"))
    .map((row) => Array.from(row.querySelectorAll("th,td")).map((c) => (c.textContent ?? "").trim()).join("\t"))
    .join("\n");
}

function TableBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    const text = tableToText(ref.current);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  }
  return (
    <div className="relative group my-3">
      <button
        type="button"
        onClick={copy}
        className="absolute right-0 -top-1 z-10 inline-flex items-center justify-center rounded p-1 bg-background/85 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted hover:text-foreground cursor-pointer"
        aria-label={copied ? "已复制" : "复制表格"}
      >
        <HugeiconsIcon icon={copied ? SuccessIcon : CopyIcon} size={13} />
      </button>
      <table ref={ref}>{children}</table>
    </div>
  );
}

// ─── MarkdownMessage ─────────────────────────────────────────────────────────

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  conversationId,
  files,
  onPreviewFile,
}: {
  content: string;
  conversationId: number | null;
  files: DisplayFile[];
  onPreviewFile: (file: PreviewableConversationFile) => void;
}) {
  const linkableFiles = useMemo(
    () =>
      files
        .filter((file) => file.storagePath && file.name)
        .map((file) => ({ name: file.name, storagePath: file.storagePath! })),
    [files]
  );

  const deferredContent = useDeferredValue(content);
  const normalizedContent = useMemo(() => normalizeModelFileLinks(deferredContent), [deferredContent]);

  const remarkPlugins: PluggableList = useMemo(
    () => [remarkGfm, [remarkFinanceFileLinks, linkableFiles]] as PluggableList,
    [linkableFiles]
  );

  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (!href) return <span>{children}</span>;

        const parsed = parseFileLinkHref(href);
        if (parsed) {
          if (!conversationId) return <span>{children}</span>;

          const { storagePath } = parsed;
          const file = files.find((item) => item.storagePath === storagePath);
          const previewFile: PreviewableConversationFile = {
            fileName: file?.name ?? parsed.name,
            mimeType: file?.mimeType ?? guessMimeType(parsed.name),
            sizeBytes: file?.sizeBytes ?? 0,
            storagePath
          };
          return (
            <button
              className="inline-flex items-center gap-1 text-meta text-primary cursor-pointer hover:underline underline-offset-2 hover:opacity-80"
              type="button"
              onClick={() => onPreviewFile(previewFile)}
            >
              {getFileIcon(previewFile.mimeType, previewFile.fileName)}
              <span>{children}</span>
            </button>
          );
        }

        const isExternalHttp =
          /^https?:\/\//i.test(href) &&
          !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(href);
        if (isExternalHttp) {
          return (
            <a
              href={href}
              onClick={(e) => { e.preventDefault(); void openExternalUrl(href); }}
              className="text-small underline-offset-2 hover:underline transition-colors cursor-pointer"
            >
              <HugeiconsIcon icon={InternetIcon} size={12} className="inline-block align-[-0.15em] mr-1 shrink-0" aria-hidden="true" />
              {children}
            </a>
          );
        }
        return <span>{children}</span>;
      },
      table: ({ children }: { children?: React.ReactNode }) => <TableBlock>{children}</TableBlock>,
      pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
    }),
    [files, onPreviewFile, conversationId]
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
});
