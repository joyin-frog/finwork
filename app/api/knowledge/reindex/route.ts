/**
 * WP12: POST /api/knowledge/reindex
 * 对无 embeddings 的活跃文档补嵌入，返回 { indexed, skipped, failed }。
 */

import { NextResponse } from "next/server";
import { getDb, listActiveKnowledgeDocuments } from "@/lib/db/sqlite";
import { getKnowledgeTextDir } from "@/lib/knowledge/storage";
import { chunkText } from "@/lib/knowledge/chunker";
import { embedTexts, storeEmbeddings, getDocIdsWithEmbeddings } from "@/lib/knowledge/embeddings";
import { EMBED_MODEL } from "@/lib/knowledge/embed-model";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export async function POST() {
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const db = getDb();
    const docs = listActiveKnowledgeDocuments();
    const hasEmbeddings = getDocIdsWithEmbeddings(db);
    const textDir = getKnowledgeTextDir();

    for (const doc of docs) {
      // 已有 embeddings 的跳过
      if (hasEmbeddings.has(doc.id)) {
        skipped++;
        continue;
      }

      // 读取文本镜像
      const txtPath = path.join(textDir, `${doc.content_hash}.txt`);
      if (!existsSync(txtPath)) {
        failed++;
        continue;
      }

      try {
        const text = readFileSync(txtPath, "utf-8");
        const chunks = chunkText(text);
        if (chunks.length === 0) {
          skipped++;
          continue;
        }

        const vectors = await embedTexts(chunks);
        if (!vectors || vectors.length === 0) {
          // 模型不可用：不计 failed，只 skip（语义层永久降级场景）
          skipped++;
          continue;
        }

        storeEmbeddings(db, doc.id, chunks, vectors, EMBED_MODEL);
        indexed++;
      } catch (err) {
        console.warn(`[reindex] doc ${doc.id} 嵌入失败:`, err instanceof Error ? err.message : String(err));
        failed++;
      }
    }

    return NextResponse.json({ ok: true, indexed, skipped, failed });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
