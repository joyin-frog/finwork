/**
 * WP12: POST /api/knowledge/reindex
 * 重建活跃文档的 BM25 词法索引，返回 { indexed, skipped, failed }。
 * WP-C blindspot-fixes:
 *   - 并发守卫：模块级 reindexInFlight 标记，并发 POST 返回 409。
 */

import { NextResponse } from "next/server";
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
    const result = await getProductionRetrievalService().reindexAll();
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed === 0 ? 200 : 207 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    reindexInFlight = false;
  }
}
