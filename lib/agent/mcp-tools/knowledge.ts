import { sanitizeDocFileName } from "@/lib/knowledge/named-mirror";
import { getKnowledgeDocumentById, listKnowledgeDocuments } from "@/lib/db/sqlite";
import { getProductionRetrievalService } from "@/lib/retrieval/production";
import { wrapExternalContext } from "../external-context";
import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

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

async function governedSearch(query: string, topK: number): Promise<string> {
  const response = await getProductionRetrievalService().search(query, topK);
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

export function createSearchKnowledgeTool(sdk: Sdk) {
  return sdk.tool(
    "search_knowledge",
    "在知识库中执行受 ACL 约束的混合检索，适合政策、制度、文档内容、数字、专有名词和科目编码。每条结果都带不可变来源版本、定位与内容哈希；禁止把没有引用的内容当作知识库事实。闲聊、问候和纯计算不要调用。topK 最大 5。",
    {
      query: z.string().describe("关键词或字面字符串；可用 'A OR B' 表达多关键词"),
      topK: z.number().int().min(1).default(3).describe("返回文件数，最大 5，超出自动取 5"),
    },
    async (args: { query: string; topK?: number }) => {
      const topK = Math.min(args.topK ?? 3, 5);
      try {
        return knowledgeText(await governedSearch(args.query, topK));
      } catch (err) {
        return knowledgeText(`知识库检索失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

export function createQueryKnowledgeTool(sdk: Sdk) {
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
        return knowledgeText(await governedSearch(args.query, args.topK ?? 10));
      } catch (err) {
        return knowledgeText(`query_knowledge 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

export function createReadFileTool(sdk: Sdk) {
  return sdk.tool(
    "read_file",
    "当现有片段信息不足、需要读取知识库文件完整内容时调用。输入知识库文件路径或文件名，返回该文件全文。仅用于知识库文件，不要用于其他文件。",
    {
      fileName: z.string().describe("文件名（如 '差旅报销制度.md'）或 docId 数字字符串"),
    },
    async (args: { fileName: string }) => {
      try {
        const doc = resolveDoc(args.fileName);
        if (!doc) return knowledgeText(`未找到 ${args.fileName}`);
        const text = getProductionRetrievalService().readKnowledgeDocument(doc.id);
        if (text.length > 200_000) {
          return knowledgeText(wrapExternalContext(text.slice(0, 200_000) + "\n\n[...内容过长，已截断，共 " + text.length + " 字符]"));
        }
        return knowledgeText(wrapExternalContext(text));
      } catch (err) {
        return knowledgeText(`read_file 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
