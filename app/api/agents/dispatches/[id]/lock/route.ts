/**
 * POST /api/agents/dispatches/[id]/lock — 锁定派发复核状态
 *
 * spec-task-templates §3 步骤 8：参照 app/api/artifacts/[id]/route.ts 可注入 handler 拆分模式。
 * 动作：pending → locked（写 locked_at）。
 *
 * 响应码：
 * - 200：锁定成功，返回更新后的派发行
 * - 404：行不存在
 * - 409：行非 pending 状态（已锁定或无复核状态）
 */

import { NextResponse } from "next/server";
import { getDispatchById, lockDispatch } from "@/lib/db/dispatch-store";

export async function POST(
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

  if (row.reviewStatus !== "pending") {
    return NextResponse.json(
      { error: `该派发记录不在待锁定状态（当前：${row.reviewStatus ?? "无复核状态"}）` },
      { status: 409 }
    );
  }

  const success = lockDispatch(id);
  if (!success) {
    // 极少数竞态：两次请求同时到达，第二次 CAS 失败
    return NextResponse.json({ error: "锁定失败（状态已被并发操作变更）" }, { status: 409 });
  }

  const updated = getDispatchById(id);
  return NextResponse.json({ ok: true, data: updated });
}
