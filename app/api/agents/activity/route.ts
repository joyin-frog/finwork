import { NextResponse } from "next/server";
import { listRecentDispatchActivity } from "@/lib/db/dispatch-store";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    // parseInt 对非数字字符串返回 NaN,Math.max(1, NaN) 仍是 NaN——直传 SQLite LIMIT 会抛异常,
    // 用 Number.isFinite 兜底非法输入(2026-07-02 review 修复)。
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 10;

    const data = listRecentDispatchActivity(limit);

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("[api/agents/activity] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
