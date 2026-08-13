import { NextRequest, NextResponse } from "next/server";
import { RetrievalError } from "@/lib/retrieval/contracts";
import { getProductionRetrievalService } from "@/lib/retrieval/production";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json({ ok: false, error: "缺少查询关键词" }, { status: 400 });
    }

    const topK = typeof body.topK === "number" && body.topK > 0 ? body.topK : 20;

    const result = await getProductionRetrievalService().searchForKnowledgeApi(query, topK);
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof RetrievalError &&
      (err.code === "embedding_unavailable" || err.code === "embedding_failed") ? 503 : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "请使用 POST 方法，body 中包含 query 字段" },
    { status: 405 }
  );
}
