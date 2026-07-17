/**
 * GET /api/agents/[roleId]/conversations — 某角色相关的会话（工作台「相关对话」页签，B5）。
 *
 * 按 roleIds 过滤的全局会话视图：会话本身归侧栏「最近」，这里只是过滤呈现。
 * 无鉴权（单机产品，与既有 agents 路由一致）。
 */

import { NextResponse } from "next/server";
import { listConversationsForRole } from "@/lib/db/sqlite";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const { roleId } = await params;
    if (!roleId) {
      return NextResponse.json({ ok: false, error: "roleId 必填" }, { status: 400 });
    }
    const rows = listConversationsForRole(roleId, 30);
    return NextResponse.json({ ok: true, data: { rows } });
  } catch (error) {
    console.error("[api/agents/[roleId]/conversations] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
