/**
 * /api/agents/[roleId]/memory — 每角色独立记忆（智能体 IA · C 刀）。
 *   GET    → 列出该角色记忆
 *   POST   { content } → 新增一条（手动添加，source=NULL）
 *   DELETE ?id=<n>     → 删除一条
 * 无鉴权（单机产品，与既有 agents 路由一致）。
 */

import { NextResponse } from "next/server";
import { listRoleMemory, addRoleMemory, deleteRoleMemory } from "@/lib/db/role-memory-store";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const { roleId } = await params;
    if (!roleId) return NextResponse.json({ ok: false, error: "roleId 必填" }, { status: 400 });
    return NextResponse.json({ ok: true, data: { rows: listRoleMemory(roleId) } });
  } catch (error) {
    console.error("[api/agents/[roleId]/memory GET] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "加载失败" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const { roleId } = await params;
    if (!roleId) return NextResponse.json({ ok: false, error: "roleId 必填" }, { status: 400 });
    const body = (await req.json()) as { content?: unknown };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return NextResponse.json({ ok: false, error: "记忆内容不能为空" }, { status: 400 });
    // 上限防止单条记忆无限膨胀系统提示（每次派发都注入，会静默耗配额）。
    if (content.length > 500) {
      return NextResponse.json({ ok: false, error: "单条记忆请控制在 500 字以内" }, { status: 400 });
    }
    const id = addRoleMemory(roleId, content);
    return NextResponse.json({ ok: true, data: { id } });
  } catch (error) {
    console.error("[api/agents/[roleId]/memory POST] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const { roleId } = await params;
    if (!roleId) return NextResponse.json({ ok: false, error: "roleId 必填" }, { status: 400 });
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: "id 非法" }, { status: 400 });
    }
    // 按 roleId 约束删除：防止一个角色删掉另一个角色的记忆（隔离边界）。
    const deleted = deleteRoleMemory(id, roleId);
    return NextResponse.json({ ok: deleted, data: { deleted } });
  } catch (error) {
    console.error("[api/agents/[roleId]/memory DELETE] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "删除失败" }, { status: 500 });
  }
}
