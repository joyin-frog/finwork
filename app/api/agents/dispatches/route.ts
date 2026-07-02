import { NextResponse } from "next/server";
import { listDispatchesByRole } from "@/lib/db/dispatch-store";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const roleId = url.searchParams.get("roleId");
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    if (!roleId) {
      return NextResponse.json(
        { ok: false, error: "缺少必要参数 roleId" },
        { status: 400 }
      );
    }

    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : 20;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

    const rows = listDispatchesByRole(roleId, limit, offset);

    return NextResponse.json({ ok: true, data: { rows, roleId, limit, offset } });
  } catch (error) {
    console.error("[api/agents/dispatches] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
