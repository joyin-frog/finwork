import { NextResponse } from "next/server";
import { listRecentDispatchActivity } from "@/lib/db/dispatch-store";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : 10;

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
