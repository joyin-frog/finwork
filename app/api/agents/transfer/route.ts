/**
 * POST /api/agents/transfer — 创建转交排队任务（D2·刀8）
 *
 * 前端点击转交卡「转给X处理」按钮时调用。
 * 校验目标角色存在且可派发（available && 未停用），插入 status='queued' 的
 * subagent_dispatches 行，返回行 id。
 *
 * 响应码：
 * - 200：排队成功，返回 { ok: true, data: { dispatchId } }
 * - 400：参数缺失、目标角色不存在、尚未启用或已停用
 */

import { NextResponse } from "next/server";
import { enqueueTransferDispatch } from "@/lib/db/dispatch-store";
import { getRoleDefinition } from "@/lib/agent/roles/registry";
import { getDisabledRoleIds } from "@/lib/agent/roles/availability";

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const { targetRoleId, taskSummary, instructions, originConversationId } = b;

  if (typeof targetRoleId !== "string" || !targetRoleId) {
    return NextResponse.json({ error: "缺少 targetRoleId" }, { status: 400 });
  }
  if (typeof taskSummary !== "string" || !taskSummary) {
    return NextResponse.json({ error: "缺少 taskSummary" }, { status: 400 });
  }
  if (typeof instructions !== "string" || !instructions) {
    return NextResponse.json({ error: "缺少 instructions" }, { status: 400 });
  }

  const role = getRoleDefinition(targetRoleId);
  if (!role) {
    return NextResponse.json({ error: `未知角色 "${targetRoleId}"` }, { status: 400 });
  }
  // enqueue 时再校验一遍：转交卡可能在角色被停用/下线之前产出
  if (!role.available) {
    return NextResponse.json(
      { error: `角色「${role.name}」尚未启用，无法转交` },
      { status: 400 }
    );
  }
  if (getDisabledRoleIds().includes(targetRoleId)) {
    return NextResponse.json(
      { error: `角色「${role.name}」已停用，无法转交。请先在「智能体」页面启用该专员` },
      { status: 400 }
    );
  }

  const dispatchId = enqueueTransferDispatch({
    targetRoleId,
    label: taskSummary,
    instructions,
    originConversationId: typeof originConversationId === "number" ? originConversationId : null,
  });

  return NextResponse.json({ ok: true, data: { dispatchId } });
}
