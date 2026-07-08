/**
 * WP15: GET /api/audit?limit=50
 * 返回近期写操作列表（倒序，含 undoable 派生字段）
 */
import { NextResponse } from "next/server";
import { listAuditEntries } from "@/lib/db/audit-store";
import { getDb } from "@/lib/db/sqlite";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(1, Number(limitParam)), 200) : 50;

    const db = getDb();
    const entries = listAuditEntries({ limit }, db);
    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "内部错误" },
      { status: 500 }
    );
  }
}
