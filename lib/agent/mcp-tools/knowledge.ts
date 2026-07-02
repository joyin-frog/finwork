import { searchKnowledge } from "@/lib/knowledge/rg-search";
import { readTextMirror } from "@/lib/knowledge/storage";
import { syncNamedMirror, getKnowledgeNamedDir } from "@/lib/knowledge/named-mirror";
import { executeKnowledgeQuery } from "@/lib/knowledge/query-sandbox";
import { getKnowledgeDocumentById, listKnowledgeDocuments, markKnowledgeHits } from "@/lib/db/sqlite";
// markKnowledgeHits 仍用于 read_file 的命中埋点;search 的埋点已下沉到 searchKnowledge
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
  // Then by file name
  const docs = listKnowledgeDocuments();
  return docs.find(d => d.file_name === fileName || d.title === fileName) ?? null;
}

// MCP 工具结果必须是 {content:[...]} object;这三个知识库工具原先直接返回 string,
// 真实 SDK 会拒(Invalid tools/call result: expected object, received string),导致
// search_knowledge 等长期 isError。统一包装修复(mock 不校验格式,故单测漏了)。
const knowledgeText = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function createSearchKnowledgeTool(sdk: Sdk) {
  return sdk.tool(
    "search_knowledge",
    "当用户询问知识、政策、文档内容、操作规范时调用。先用 ripgrep 在知识库中精确搜索关键词，返回 top3 文件的匹配片段（含前后各 5 行上下文）。闲聊、问候、纯计算类问题不要调用此工具。无结果时返回明确的空提示。",
    {
      query: z.string().describe("自然语言或关键词；可用 'A OR B' 表达多关键词"),
      topK: z.number().int().min(1).max(5).default(3),
    },
    async (args: { query: string; topK?: number }) => {
      try {
        const res = await searchKnowledge({ query: args.query, topK: args.topK ?? 3 });
        if (!res.ok) return knowledgeText(`知识库搜索失败：${res.error}`);
        if (!res.data.files.length) return knowledgeText("知识库中未找到相关内容。");
        // 命中埋点已在 searchKnowledge 内统一处理

        const lines: string[] = [];
        for (const f of res.data.files) {
          lines.push(`【${f.title} / ${f.category}】（命中 ${f.hitCount} 次）`);
          for (const m of f.matches) {
            const ctx = [...m.before, `>>> L${m.lineNo}: ${m.line}`, ...m.after];
            lines.push(ctx.join("\n"));
          }
          lines.push("---");
        }
        return knowledgeText(wrapExternalContext(lines.join("\n")));
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
      "用只读命令在知识库里精确定位、统计或多步钻取。当 search_knowledge 的关键词匹配不够精确,或需要先看有哪些文件、再取指定章节时使用。",
      "工作目录是知识库文本(文件名即文档标题)。可用命令:rg grep cat head tail wc sort uniq cut ls find tr,可用 | 串成管道。",
      "示例:",
      "  ls                                  # 看知识库有哪些文档",
      "  rg -l '差旅'                        # 哪些文档提到差旅",
      "  rg -n '住宿标准' | head -20         # 定位关键词所在行",
      "  head -80 报销管理制度.txt | tail -40 # 取第 40-80 行(章节)",
      "  rg -c '发票' 报销管理制度.txt        # 统计某词出现次数",
      "不支持重定向、命令串联、写入操作;只读检索。",
    ].join("\n"),
    {
      command: z.string().describe("单条命令或用 | 连接的管道,如 \"rg -n '标准' | head -20\""),
    },
    async (args: { command: string }) => {
      try {
        syncNamedMirror();
        const res = await executeKnowledgeQuery(args.command, getKnowledgeNamedDir());
        if (!res.ok) return knowledgeText(`命令未执行:${res.error}`);
        if (!res.output.trim()) return knowledgeText("命令执行成功,但没有匹配结果。可调整关键词或先用 ls 查看可检索的文档。");
        const out = res.truncated ? `${res.output}\n\n[输出较长已截断,请缩小检索范围或加 head 限制行数]` : res.output;
        return knowledgeText(wrapExternalContext(out));
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
        markKnowledgeHits([doc.id]);
        const text = readTextMirror(doc.content_hash);
        if (!text) return knowledgeText(`未找到 ${args.fileName} 的文本内容`);
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
