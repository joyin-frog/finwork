import { NextRequest, NextResponse } from "next/server";
import { searchKnowledge } from "@/lib/knowledge/rg-search";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json({ ok: false, error: "缺少查询关键词" }, { status: 400 });
    }

    const topK = typeof body.topK === "number" && body.topK > 0 ? body.topK : 20;

    const result = await searchKnowledge({ query, topK });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "请使用 POST 方法，body 中包含 query 字段" },
    { status: 405 }
  );
}
