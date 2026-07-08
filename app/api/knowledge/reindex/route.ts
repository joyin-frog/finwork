/**
 * WP12: POST /api/knowledge/reindex
 * 对无 embeddings 的活跃文档补嵌入，返回 { indexed, skipped, failed }。
 * WP-C blindspot-fixes:
 *   - 并发守卫：模块级 reindexInFlight 标记，并发 POST 返回 409。
 *   - 接线 ensureEmbedModel：ok:false 时提前返回 modelUnavailable:true。
 *   - 响应区分："模型不可用"与"已索引跳过"分开（modelUnavailable vs skipped）。
 */

import { NextResponse } from "next/server";
import { getDb, listActiveKnowledgeDocuments } from "@/lib/db/sqlite";
import { getKnowledgeTextDir } from "@/lib/knowledge/storage";
import { chunkText } from "@/lib/knowledge/chunker";
import { embedTexts, storeEmbeddings, getDocIdsWithEmbeddings } from "@/lib/knowledge/embeddings";
import { EMBED_MODEL, ensureEmbedModel } from "@/lib/knowledge/embed-model";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/** 并发守卫：同时只允许一个 reindex 请求 */
let reindexInFlight = false;

export async function POST() {
  if (reindexInFlight) {
    return NextResponse.json(
      { ok: false, error: "reindex already in progress" },
      { status: 409 }
    );
  }
  reindexInFlight = true;
  try {
    // 确保嵌入模型可用（下载 ~24MB；超时即返回 modelUnavailable）
    const modelResult = await ensureEmbedModel();
    if (!modelResult.ok) {
      return NextResponse.json({ ok: true, modelUnavailable: true, indexed: 0, skipped: 0, failed: 0 });
    }

    let indexed = 0;
    let skipped = 0;
    let failed = 0;

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
  } finally {
    reindexInFlight = false;
  }
}
