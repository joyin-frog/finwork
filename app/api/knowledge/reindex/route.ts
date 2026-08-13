/**
 * WP12: POST /api/knowledge/reindex
 * 对无 embeddings 的活跃文档补嵌入，返回 { indexed, skipped, failed }。
 * WP-C blindspot-fixes:
 *   - 并发守卫：模块级 reindexInFlight 标记，并发 POST 返回 409。
 *   - 接线 ensureEmbedModel：ok:false 时提前返回 modelUnavailable:true。
 *   - 响应区分："模型不可用"与"已索引跳过"分开（modelUnavailable vs skipped）。
 */

import { NextResponse } from "next/server";
import { ensureEmbedModel } from "@/lib/knowledge/embed-model";
import { RetrievalError } from "@/lib/retrieval/contracts";
import { getProductionRetrievalService } from "@/lib/retrieval/production";

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
      return NextResponse.json(
        { ok: false, error: `检索模型不可用：${modelResult.detail}` },
        { status: 503 }
      );
    }
    const result = await getProductionRetrievalService().reindexAll();
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed === 0 ? 200 : 207 });
  } catch (err) {
    const status = err instanceof RetrievalError &&
      (err.code === "embedding_unavailable" || err.code === "embedding_failed") ? 503 : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  } finally {
    reindexInFlight = false;
  }
}
