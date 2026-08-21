import { createHash } from "node:crypto";
import type { DocumentLocator } from "@/lib/artifacts/contracts";
import { StructureChunkSchema, type RetrievalChunkEdge, type RetrievalNodeType, type StructureChunk } from "./contracts";

const MAX_NODE_CHARS = 2_000;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const LIST_ITEM = /^\s*(?:[-*+] |\d+[.)]\s+)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chunkId(documentId: string, ordinal: number, start: number, text: string): string {
  return `rch_${digest(`${documentId}:${ordinal}:${start}:${text}`).slice(0, 32)}`;
}

function approximateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const other = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return cjk + other;
}

type RawNode = {
  sourceOrdinal: number;
  nodeType: RetrievalNodeType;
  depth: number;
  heading?: string;
  sectionPath: string[];
  text: string;
  start: number;
  end: number;
  parentSourceOrdinal?: number;
};

function locate(text: string, nodeId: string, sectionPath: string[], start: number, end: number): DocumentLocator {
  if (sectionPath.length > 0 && text.trim() === sectionPath.at(-1)) {
    return { kind: "section", sectionPath };
  }
  return { kind: "char_range", nodeId, start, end };
}

function splitLongNode(node: RawNode): RawNode[] {
  if (node.text.length <= MAX_NODE_CHARS) return [node];
  const result: RawNode[] = [];
  let cursor = 0;
  while (cursor < node.text.length) {
    let end = Math.min(node.text.length, cursor + MAX_NODE_CHARS);
    if (end < node.text.length) {
      const boundary = Math.max(node.text.lastIndexOf("。", end), node.text.lastIndexOf("\n", end), node.text.lastIndexOf(". ", end));
      if (boundary > cursor + Math.floor(MAX_NODE_CHARS * 0.6)) end = boundary + 1;
    }
    const leading = node.text.slice(cursor, end).search(/\S/);
    const actualStart = cursor + Math.max(0, leading);
    const body = node.text.slice(actualStart, end).trimEnd();
    if (body) result.push({ ...node, text: body, start: node.start + actualStart, end: node.start + actualStart + body.length });
    cursor = end;
  }
  return result;
}

function rawNodes(text: string): RawNode[] {
  const nodes: RawNode[] = [];
  const sectionPath: string[] = [];
  const sectionOrdinals: Array<number | undefined> = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let paragraphStart = -1;
  let paragraphLines: string[] = [];
  let paragraphType: RetrievalNodeType = "paragraph";

  const flush = () => {
    if (paragraphStart < 0) return;
    const raw = paragraphLines.join("").trimEnd();
    const leading = raw.search(/\S/);
    const body = leading < 0 ? "" : raw.slice(leading);
    if (body) {
      const depth = sectionPath.length;
      nodes.push({
        sourceOrdinal: nodes.length,
        nodeType: paragraphType,
        depth,
        sectionPath: [...sectionPath],
        text: body,
        start: paragraphStart + Math.max(0, leading),
        end: paragraphStart + Math.max(0, leading) + body.length,
        parentSourceOrdinal: sectionOrdinals[depth - 1],
      });
    }
    paragraphStart = -1;
    paragraphLines = [];
    paragraphType = "paragraph";
  };

  for (const lineWithBreak of lines) {
    const line = lineWithBreak.replace(/\r?\n$/, "");
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const depth = heading[1].length;
      const title = heading[2].trim();
      sectionPath.splice(depth - 1);
      sectionPath[depth - 1] = title;
      sectionOrdinals.splice(depth - 1);
      const ordinal = nodes.length;
      nodes.push({
        sourceOrdinal: ordinal,
        nodeType: "section",
        depth: depth - 1,
        heading: title,
        sectionPath: [...sectionPath],
        text: title,
        start: offset + line.indexOf(title),
        end: offset + line.indexOf(title) + title.length,
        parentSourceOrdinal: sectionOrdinals[depth - 2],
      });
      sectionOrdinals[depth - 1] = ordinal;
    } else if (!line.trim()) {
      flush();
    } else {
      const nextType: RetrievalNodeType = TABLE_ROW.test(line) ? "table_row" : LIST_ITEM.test(line) ? "list" : line.startsWith("```") ? "code" : "paragraph";
      if (paragraphStart >= 0 && nextType !== paragraphType) flush();
      if (paragraphStart < 0) {
        paragraphStart = offset;
        paragraphType = nextType;
      }
      paragraphLines.push(lineWithBreak);
    }
    offset += lineWithBreak.length;
  }
  flush();
  return nodes.flatMap(splitLongNode);
}

export function chunkStructuredText(documentId: string, text: string): { chunks: StructureChunk[]; edges: RetrievalChunkEdge[] } {
  if (!text.trim()) return { chunks: [], edges: [] };
  const raw = rawNodes(text);
  const chunks: StructureChunk[] = [];
  const ids = raw.map((node, ordinal) => chunkId(documentId, ordinal, node.start, node.text));
  const sourceToFirstChunk = new Map<number, string>();
  raw.forEach((node, ordinal) => {
    if (!sourceToFirstChunk.has(node.sourceOrdinal)) sourceToFirstChunk.set(node.sourceOrdinal, ids[ordinal]);
  });
  raw.forEach((node, ordinal) => {
    const id = ids[ordinal];
    const parentId = node.parentSourceOrdinal === undefined
      ? undefined
      : sourceToFirstChunk.get(node.parentSourceOrdinal);
    const parsed = StructureChunkSchema.parse({
      id,
      parentId,
      ordinal,
      nodeType: node.nodeType,
      depth: node.depth,
      heading: node.heading,
      text: node.text,
      textHash: digest(node.text),
      locator: locate(node.text, id, node.sectionPath, node.start, node.end),
      charStart: node.start,
      charEnd: node.end,
      tokenCount: approximateTokens(node.text),
    });
    chunks.push(parsed);
  });

  const edges: RetrievalChunkEdge[] = [];
  chunks.forEach((chunk, index) => {
    if (chunk.parentId) edges.push({ fromChunkId: chunk.id, toChunkId: chunk.parentId, relation: "parent" });
    const previous = chunks[index - 1];
    if (previous) {
      edges.push({ fromChunkId: previous.id, toChunkId: chunk.id, relation: "next" });
      edges.push({ fromChunkId: chunk.id, toChunkId: previous.id, relation: "previous" });
    }
    if (chunk.parentId) {
      for (const sibling of chunks.slice(0, index)) {
        if (sibling.parentId === chunk.parentId) edges.push({ fromChunkId: sibling.id, toChunkId: chunk.id, relation: "same_section" });
      }
    }
  });
  return { chunks, edges };
}
