/**
 * DELETE /api/agents/dispatches/[id] — 移除排队任务（D3·刀8）
 *
 * 只允许删除 status='queued' 的行，防止误删进行中或已完成的任务。
 *
 * 响应码：
 * - 200：删除成功
 * - 404：行不存在
 * - 409：行非 queued 状态（不允许删除）
 */

import { NextResponse } from "next/server";
import { getDispatchById, removeQueuedDispatch } from "@/lib/db/dispatch-store";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);

  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "无效 id" }, { status: 400 });
  }

  const row = getDispatchById(id);
  if (!row) {
    return NextResponse.json({ error: "派发记录不存在" }, { status: 404 });
  }
  if (row.status !== "queued") {
    return NextResponse.json(
      { error: `只能移除排队中的任务（当前状态：${row.status}）` },
      { status: 409 }
    );
  }

  const removed = removeQueuedDispatch(id);
  if (!removed) {
    // 极少数竞态
    return NextResponse.json({ error: "移除失败（状态已被并发操作变更）" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
