/**
 * GET  /api/artifacts/[id] — 返回 payload+state
 * PATCH /api/artifacts/[id] — 更新单条 item state（校验 itemId 存在 + state 枚举）
 *
 * WP14a: ChecklistCard 勾选交互的持久化端点。
 * 无鉴权（单机产品，与既有 route 一致）。
 * PATCH 无乐观锁（last-write-wins，单机产品可接受）。
 */

import { NextResponse } from "next/server";
import { handleGet, handlePatch } from "./handlers";

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
