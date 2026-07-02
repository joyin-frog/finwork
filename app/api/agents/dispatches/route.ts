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

    // parseInt 对非数字字符串返回 NaN,Math.max(1/0, NaN) 仍是 NaN——直传 SQLite LIMIT/OFFSET 会抛异常,
    // 用 Number.isFinite 兜底非法输入(2026-07-02 review 修复)。
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
    const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 20;
    const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;

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
