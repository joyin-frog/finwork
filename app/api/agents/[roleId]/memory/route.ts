/** 角色详情页的人工记忆入口。只读写 governed memory，不维护第二张角色记忆表。 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isTrustedLocalMutation } from "@/lib/api/local-request";
import { getRoleDefinition } from "@/lib/agent/roles/registry";
import { getDb } from "@/lib/db/sqlite";
import {
  createGovernedMemoryCandidate,
  createManualMemoryConflictKey,
  createManualMemoryContent,
  GovernedMemoryStore,
  readManualMemoryContent,
} from "@/lib/memory-v2";

const PRINCIPAL = { id: "local-user", type: "user" as const, tenantId: "local" };

function rejectUntrusted(request: NextRequest): NextResponse | undefined {
  if (isTrustedLocalMutation(request)) return undefined;
  return NextResponse.json({ ok: false, error: "cross-site request rejected" }, { status: 403 });
}

function requireRole(roleId: string) {
  const role = getRoleDefinition(roleId);
  if (!role) throw new Error(`未知角色:${roleId}`);
  return role;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const { roleId } = await params;
    requireRole(roleId);
    const rows = new GovernedMemoryStore(getDb()).list({
      statuses: ["approved"],
      tenantId: "local",
      roleId,
      limit: 200,
    }).map((memory) => ({
      id: memory.id,
      content: readManualMemoryContent(memory.content).summary,
      source: "手动添加（已批准）",
      createdAt: memory.createdAt,
    }));
    return NextResponse.json({ ok: true, data: { rows } });
  } catch (error) {
    console.error("[api/agents/[roleId]/memory GET] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "加载失败" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const rejected = rejectUntrusted(req);
    if (rejected) return rejected;
    const { roleId } = await params;
    requireRole(roleId);
    const body = (await req.json()) as { content?: unknown };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return NextResponse.json({ ok: false, error: "记忆内容不能为空" }, { status: 400 });
    // 上限防止单条记忆无限膨胀系统提示（每次派发都注入，会静默耗配额）。
    if (content.length > 500) {
      return NextResponse.json({ ok: false, error: "单条记忆请控制在 500 字以内" }, { status: 400 });
    }
    const db = getDb();
    const store = new GovernedMemoryStore(db);
    const duplicate = store.findExactSummary({ summary: content, tenantId: "local", roleId })
      .find((memory) => memory.approvalStatus === "approved");
    if (duplicate) return NextResponse.json({ ok: true, data: { id: duplicate.id, duplicate: true } });

    const now = new Date().toISOString();
    const memoryId = randomUUID();
    const created = createGovernedMemoryCandidate(db, {
      content,
      principal: PRINCIPAL,
      sensitivity: "confidential",
      at: now,
      candidate: {
        conflictKey: createManualMemoryConflictKey("semantic", `${roleId}:${content}`),
        record: {
          id: memoryId,
          kind: "semantic",
          scope: { tenantId: "local", roleId },
          entityRefs: [],
          content: createManualMemoryContent(`${roleId} 角色口径`, content),
          confidence: 1,
          sensitivity: "confidential",
          createdAt: now,
          owner: PRINCIPAL,
        },
      },
    });
    const approved = store.approve({
      memoryId: created.record.id,
      approver: PRINCIPAL,
      reason: "用户在角色记忆设置中明确添加并批准",
      at: now,
    });
    return NextResponse.json({ ok: true, data: { id: approved.id, duplicate: false } });
  } catch (error) {
    console.error("[api/agents/[roleId]/memory POST] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "保存失败" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
): Promise<NextResponse> {
  try {
    const rejected = rejectUntrusted(req);
    if (rejected) return rejected;
    const { roleId } = await params;
    requireRole(roleId);
    const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
    if (!id) {
      return NextResponse.json({ ok: false, error: "id 非法" }, { status: 400 });
    }
    const store = new GovernedMemoryStore(getDb());
    const memory = store.get(id);
    if (!memory || memory.scope.roleId !== roleId) {
      return NextResponse.json({ ok: false, error: "记忆不存在" }, { status: 404 });
    }
    const deleted = store.requestDeletion({ memoryId: id, requester: PRINCIPAL, at: new Date().toISOString() });
    return NextResponse.json({ ok: true, data: { deleted: deleted.status === "completed", proof: deleted.status === "completed" ? deleted.proof : undefined } });
  } catch (error) {
    console.error("[api/agents/[roleId]/memory DELETE] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "删除失败" }, { status: 500 });
  }
}
