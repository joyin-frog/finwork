/**
 * GET  /api/artifacts/[id] — 返回 payload+state
 * PATCH /api/artifacts/[id] — 更新单条 item state（校验 itemId 存在 + state 枚举）
 *
 * WP14a: ChecklistCard 勾选交互的持久化端点。
 * 无鉴权（单机产品，与既有 route 一致）。
 * PATCH 无乐观锁（last-write-wins，单机产品可接受）。
 */

import { NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { getArtifact, patchArtifactState } from "@/lib/db/artifact-store";

// ── 可注入 db 的核心逻辑（供测试直接调用） ──────────────────────────────────

export function handleGet(db: DatabaseSync, id: string): NextResponse {
  const artifact = getArtifact(db, id);
  if (!artifact) {
    return NextResponse.json({ error: "工件不存在" }, { status: 404 });
  }
  return NextResponse.json({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    items: artifact.items,
    state: artifact.state,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  });
}

export async function handlePatch(
  db: DatabaseSync,
  id: string,
  body: unknown
): Promise<NextResponse> {
  const { itemId, state } = (body ?? {}) as Record<string, unknown>;

  if (typeof itemId !== "string" || !itemId) {
    return NextResponse.json({ error: "itemId 必须为非空字符串" }, { status: 400 });
  }
  if (typeof state !== "string" || !["open", "done", "ignored"].includes(state)) {
    return NextResponse.json(
      { error: `state 必须为枚举值之一：open / done / ignored，收到：${String(state)}` },
      { status: 400 }
    );
  }

  try {
    patchArtifactState(db, id, itemId, state as "open" | "done" | "ignored");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // itemId 不在 payload → 400
    if (msg.includes("不在 payload")) {
      return NextResponse.json({ error: `itemId "${itemId}" 不存在于该工件` }, { status: 400 });
    }
    // artifact 不存在 → 404
    if (msg.includes("不存在")) {
      return NextResponse.json({ error: "工件不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: `更新失败：${msg}` }, { status: 500 });
  }

  const updated = getArtifact(db, id);
  if (!updated) {
    return NextResponse.json({ error: "工件不存在" }, { status: 404 });
  }
  return NextResponse.json({
    id: updated.id,
    kind: updated.kind,
    title: updated.title,
    items: updated.items,
    state: updated.state,
    updatedAt: updated.updatedAt,
  });
}

// ── Next.js 路由导出（生产路径，使用 getDb() 单例） ───────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const { getDb } = await import("@/lib/db/sqlite");
  return handleGet(getDb(), id);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体解析失败" }, { status: 400 });
  }
  const { getDb } = await import("@/lib/db/sqlite");
  return handlePatch(getDb(), id, body);
}
