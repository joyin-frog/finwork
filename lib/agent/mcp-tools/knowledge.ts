import { sanitizeDocFileName } from "@/lib/knowledge/named-mirror";
import { getKnowledgeDocumentById, listKnowledgeDocuments } from "@/lib/db/sqlite";
import {
  getProductionRetrievalService,
  type ProductionRetrievalService,
} from "@/lib/retrieval/production";
import { wrapExternalContext } from "../external-context";
import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;
type KnowledgeToolOptions = {
  getRetrievalService?: () => ProductionRetrievalService;
};

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 1_000;
const MAX_READ_CHARS = 50_000;

function resolveDoc(fileName: string) {
  // Try by id first
  const idNum = Number(fileName);
  if (Number.isFinite(idNum) && idNum > 0) {
    return getKnowledgeDocumentById(idNum) ?? null;
  }
  // Then by exact file_name or title
  const docs = listKnowledgeDocuments();
  const exact = docs.find(d => d.file_name === fileName || d.title === fileName);
  if (exact) return exact;

  // Fallback: compare request name against sanitized title (same transform as syncNamedMirror).
  // Handles the case where the model calls read_file with the mirror file name it saw via rg
  // (e.g. "科目--新系统.txt") while the DB has file_name "科目--新系统.xlsx".
  const requestBase = fileName.replace(/\.txt$/i, "");
  return (
    docs.find(d => {
      const sanitized = sanitizeDocFileName(d.title, d.id);
      return sanitized === requestBase || sanitized === fileName;
    }) ?? null
  );
}

// MCP 工具结果必须是 {content:[...]} object;这三个知识库工具原先直接返回 string,
// 真实 SDK 会拒(Invalid tools/call result: expected object, received string),导致
// search_knowledge 等长期 isError。统一包装修复(mock 不校验格式,故单测漏了)。
const knowledgeText = (text: string) => ({ content: [{ type: "text" as const, text }] });

async function governedSearch(
  query: string,
  topK: number,
  service: ProductionRetrievalService,
): Promise<string> {
  const response = await service.search(query, topK);
  if (response.hits.length === 0) return "知识库中未找到相关内容。";
  return wrapExternalContext(response.hits.map((hit, index) => {
    const citation = hit.citation;
    return [
      `【引用 ${index + 1}｜${citation.title}】`,
      citation.quotedText,
      `来源版本：${citation.artifactVersionId}`,
      `定位：${JSON.stringify(citation.locator)}`,
      `内容哈希：${citation.artifactHash}`,
    ].join("\n");
  }).join("\n\n---\n\n"));
}

export function createSearchKnowledgeTool(sdk: Sdk, options: KnowledgeToolOptions = {}) {
  const retrieval = options.getRetrievalService ?? getProductionRetrievalService;
  return sdk.tool(
    "search_knowledge",
    "在知识库中执行受 ACL 约束的 BM25 关键词检索，适合政策、制度、文档内容、数字、专有名词和科目编码。可先把自然语言问题改写为 2-3 组制度术语再检索。每条结果都带不可变来源版本、定位与内容哈希；禁止把没有引用的内容当作知识库事实。闲聊、问候和纯计算不要调用。topK 最大 5。",
    {
      query: z.string().describe("关键词或字面字符串；可用 'A OR B' 表达多关键词"),
      topK: z.number().int().min(1).default(3).describe("返回文件数，最大 5，超出自动取 5"),
    },
    async (args: { query: string; topK?: number }) => {
      const topK = Math.min(args.topK ?? 3, 5);
      try {
        return knowledgeText(await governedSearch(args.query, topK, retrieval()));
      } catch (err) {
        return knowledgeText(`知识库检索失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

export function createQueryKnowledgeTool(sdk: Sdk, options: KnowledgeToolOptions = {}) {
  const retrieval = options.getRetrievalService ?? getProductionRetrievalService;
  return sdk.tool(
    "query_knowledge",
    [
      "在知识库中扩大候选范围做受 ACL 约束的深度检索；适合普通检索片段不足时继续钻取。",
      "返回精确引用，不执行 shell 命令，也不允许绕过检索权限直接扫描文本镜像。",
    ].join("\n"),
    {
      query: z.string().describe("需要继续钻取的问题或关键词"),
      topK: z.number().int().min(1).max(20).default(10).describe("最多返回的引用片段数"),
    },
    async (args: { query: string; topK?: number }) => {
      try {
        return knowledgeText(await governedSearch(args.query, args.topK ?? 10, retrieval()));
      } catch (err) {
        return knowledgeText(`query_knowledge 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

function renderKnowledgeRange(
  fileName: string,
  text: string,
  startLine: number,
  requestedEndLine?: number,
): string {
  const normalizedText = text.replace(/\r\n/g, "\n");
  const lines = normalizedText.split("\n");
  if (startLine > lines.length) {
    return `${fileName} 共 ${lines.length} 行，请把 startLine 调整到有效范围。`;
  }
  const endLine = Math.min(
    lines.length,
    requestedEndLine ?? startLine + DEFAULT_READ_LINES - 1,
    startLine + MAX_READ_LINES - 1,
  );
  if (endLine < startLine) return "endLine 必须大于或等于 startLine。";
  const rendered: string[] = [];
  let chars = 0;
  let actualEndLine = startLine - 1;
  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    const line = `${lineNo}: ${lines[lineNo - 1]}`;
    if (rendered.length === 0 && line.length > MAX_READ_CHARS) {
      const startChar = lines.slice(0, lineNo - 1).reduce((sum, value) => sum + value.length + 1, 0);
      return renderKnowledgeCharRange(fileName, normalizedText, startChar, MAX_READ_CHARS);
    }
    if (rendered.length > 0 && chars + line.length + 1 > MAX_READ_CHARS) break;
    rendered.push(line);
    chars += line.length + 1;
    actualEndLine = lineNo;
  }
  const continuation = actualEndLine < lines.length
    ? `\n\n[内容未读完；下一次可从 startLine=${actualEndLine + 1} 继续，共 ${lines.length} 行]`
    : "";
  return [
    `文件：${fileName}｜第 ${startLine}-${actualEndLine} 行｜共 ${lines.length} 行`,
    "",
    rendered.join("\n"),
  ].join("\n") + continuation;
}

function renderKnowledgeCharRange(
  fileName: string,
  text: string,
  startChar: number,
  requestedMaxChars?: number,
): string {
  const normalizedText = text.replace(/\r\n/g, "\n");
  if (startChar >= normalizedText.length) {
    return `${fileName} 共 ${normalizedText.length} 个字符，请把 startChar 调整到有效范围。`;
  }
  const maxChars = Math.min(requestedMaxChars ?? MAX_READ_CHARS, MAX_READ_CHARS);
  const endExclusive = Math.min(normalizedText.length, startChar + maxChars);
  const continuation = endExclusive < normalizedText.length
    ? `\n\n[内容未读完；下一次可从 startChar=${endExclusive} 继续，共 ${normalizedText.length} 个字符]`
    : "";
  return [
    `文件：${fileName}｜字符 ${startChar}-${endExclusive - 1}｜共 ${normalizedText.length} 个字符`,
    "",
    normalizedText.slice(startChar, endExclusive),
  ].join("\n") + continuation;
}

export function createReadFileTool(sdk: Sdk, options: KnowledgeToolOptions = {}) {
  const retrieval = options.getRetrievalService ?? getProductionRetrievalService;
  return sdk.tool(
    "read_file",
    "当检索片段不足时，分页精读知识库原文。普通文本用 startLine/endLine 按行读取；超长单行或压缩文本用 0-based startChar/maxChars 按字符读取。单次最多 1000 行或 50000 字符。仅用于知识库文件，不要用于会话附件或工作区文件。",
    {
      fileName: z.string().describe("文件名（如 '差旅报销制度.md'）或 docId 数字字符串"),
      startLine: z.number().int().min(1).default(1).describe("起始行，1-based，默认 1"),
      endLine: z.number().int().min(1).optional().describe("结束行，1-based；省略时读取最多 400 行"),
      startChar: z.number().int().min(0).optional().describe("超长单行文件的起始字符偏移，0-based；设置后优先使用字符模式"),
      maxChars: z.number().int().min(1).max(MAX_READ_CHARS).optional().describe("字符模式单次读取长度，最大 50000"),
    },
    async (args: {
      fileName: string;
      startLine?: number;
      endLine?: number;
      startChar?: number;
      maxChars?: number;
    }) => {
      try {
        const doc = resolveDoc(args.fileName);
        if (!doc) return knowledgeText(`未找到 ${args.fileName}`);
        const service = retrieval();
        await service.ensureKnowledgeDocumentsReady();
        const text = service.readKnowledgeDocument(doc.id);
        const rendered = args.startChar === undefined
          ? renderKnowledgeRange(doc.file_name, text, args.startLine ?? 1, args.endLine)
          : renderKnowledgeCharRange(doc.file_name, text, args.startChar, args.maxChars);
        return knowledgeText(wrapExternalContext(rendered));
      } catch (err) {
        return knowledgeText(`read_file 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
