import type { PreviewFileSelection } from "@/app/shared/file-preview-page";
import type { PreviewableConversationFile } from "@/app/chat/chat-file-browser";

type DraftAttachmentLike = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  text?: string;
};

type DisplayFileLike = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath?: string;
  dataUrl?: string;
  text?: string;
};

type ReferencedFileLike = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
};

export function previewSelectionFromConversationFile(
  conversationId: number,
  file: PreviewableConversationFile
): PreviewFileSelection {
  return {
    kind: "conversation",
    conversationId,
    attachmentId: file.id,
    storagePath: file.storagePath,
    name: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes
  };
}

export function previewSelectionFromDraftAttachment(file: DraftAttachmentLike): PreviewFileSelection {
  return {
    kind: "draft",
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.size,
    dataUrl: file.dataUrl,
    text: file.text
  };
}

export function previewSelectionFromReferencedFile(
  conversationId: number,
  file: ReferencedFileLike
): PreviewFileSelection {
  return {
    kind: "conversation",
    conversationId,
    storagePath: file.storagePath,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes
  };
}

export function previewSelectionFromDisplayFile(
  file: DisplayFileLike,
  conversationId: number | null
): PreviewFileSelection | null {
  if (file.storagePath && conversationId) {
    return {
      kind: "conversation",
      conversationId,
      storagePath: file.storagePath,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes
    };
  }
  if (file.dataUrl) {
    return {
      kind: "draft",
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      dataUrl: file.dataUrl,
      text: file.text
    };
  }
  return null;
}

export function shouldShowScrollToBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 96) {
  return scrollHeight - (scrollTop + clientHeight) > threshold;
}

/**
 * Parse a file link href from model-generated markdown into a { name, storagePath } pair.
 *
 * Handles:
 *   - `finance-file://<encoded-storagePath>` → decodes storagePath; name = basename
 *   - `sandbox:<abs-path>` / `file:<abs-path>` containing `/generate/` → name = basename,
 *     storagePath = `generate/<name>` (conversation-relative)
 *   - Plain absolute paths (no scheme) containing `/generate/` → same treatment
 *   - `http(s)://` and any other unrecognised href → returns null (treat as normal link)
 */
export function parseFileLinkHref(href: string): { name: string; storagePath: string } | null {
  // finance-file:// scheme — existing trusted scheme
  if (href.startsWith("finance-file://")) {
    const storagePath = decodeURIComponent(href.slice("finance-file://".length));
    const name = storagePath.split(/[\\/]/).filter(Boolean).pop() ?? storagePath;
    return { name, storagePath };
  }

  // sandbox: or file: scheme — model-generated absolute paths
  if (href.startsWith("sandbox:") || href.startsWith("file:")) {
    const rawPath = href.startsWith("sandbox:")
      ? href.slice("sandbox:".length)
      : href.startsWith("file:///")
      ? href.slice("file://".length)   // keep leading /
      : href.slice("file:".length);
    const decoded = decodeURIComponent(rawPath);
    const name = decoded.split(/[\\/]/).filter(Boolean).pop() ?? decoded;
    const storagePath = `generate/${name}`;
    return { name, storagePath };
  }

  // Absolute path (no scheme) that contains /generate/ — fallback for bare paths
  if (!href.includes("://") && href.includes("/generate/")) {
    const decoded = decodeURIComponent(href);
    const name = decoded.split(/[\\/]/).filter(Boolean).pop() ?? decoded;
    const storagePath = `generate/${name}`;
    return { name, storagePath };
  }

  // Everything else (http/https, unknown schemes) — leave alone
  return null;
}

/**
 * 把模型在最终回答里手写的"文件链接"在喂给 ReactMarkdown 之前规整成干净的 finance-file:// 链接。
 *
 * 为什么需要:模型常无视系统提示,写成 `[名字](sandbox:/abs/path/名字.pptx)`。当绝对路径里含**空格**
 * (macOS 应用数据目录就是 `~/Library/Application Support/...`)时,CommonMark 不接受带空格的链接目标,
 * 整个 `[text](url)` 退化成**字面文本**渲染——链接没了,路径和里面的括号(如文件名 `(2)`)还漏在正文里。
 * (路径无空格的情况 CommonMark 能正常解析,a 组件里 parseFileLinkHref 已能接住,这里规整后更统一。)
 *
 * 做法:用比 CommonMark 更宽松的扫描找到 `[text](...)` 的边界——允许 URL 内含空格,按括号配平找闭合 `)`——
 * 再用 parseFileLinkHref 判定是不是文件链接;是则把 URL 换成 `finance-file://<编码 storagePath>`
 * (无空格、括号配平,CommonMark 必能解析,且被 a 组件识别为可预览文件)。非文件链接(http 等)原样保留。
 */
export function normalizeModelFileLinks(text: string): string {
  if (!text || !text.includes("](")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        // 括号配平扫描真正的闭合 `)`(允许 URL 内含空格,比 CommonMark 宽松)
        let depth = 1;
        let j = close + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") depth--;
          if (depth === 0) break;
          j++;
        }
        if (depth === 0) {
          const linkText = text.slice(i + 1, close);
          const url = text.slice(close + 2, j).trim();
          const parsed = parseFileLinkHref(url);
          if (parsed) {
            out += `[${linkText}](finance-file://${encodeURIComponent(parsed.storagePath)})`;
            i = j + 1;
            continue;
          }
        }
      }
    }
    out += text[i];
    i++;
  }
  return out;
}
