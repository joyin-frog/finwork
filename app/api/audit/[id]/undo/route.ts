/**
 * WP15: POST /api/audit/[id]/undo
 * 执行撤销操作。
 *
 * 响应：
 *   200 + {undone, auditId, ops}  撤销成功
 *   400 + {error}                不可撤销（无 undo 载荷）
 *   404 + {error}                记录不存在
 *   409 + {error}                已撤销（二次撤销）
 *   500 + {error}                内部错误
 */
import { NextResponse } from "next/server";
import { undoAuditEntry } from "@/lib/db/audit-store";
import { getDb } from "@/lib/db/sqlite";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效的 id 参数" }, { status: 400 });
  }

  try {
    const db = getDb();
    const result = undoAuditEntry(id, db);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // 已撤销
    if (/已撤销|already undone/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    // 不可撤销
    if (/不可撤销|undoable/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    // 不存在
    if (/不存在|id=\d+ 的记录/i.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    // 其他
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
