import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/sqlite";
import { captureFoundationDiagnostics } from "@/lib/observability/foundation-diagnostics";
import { CapabilityFoundationRollout, type RolloutMode } from "@/lib/runtime/capability-foundation-rollout";

export const dynamic = "force-dynamic";

function unavailable() {
  return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
}

export async function GET() {
  if (process.env.NODE_ENV === "production") return unavailable();
  try {
    return NextResponse.json({ ok: true, snapshot: captureFoundationDiagnostics(getDb()) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "诊断快照生成失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return unavailable();
  try {
    const body = await request.json() as { action?: RolloutMode; reason?: string };
    const reason = body.reason?.trim() ?? "";
    if (!reason) return NextResponse.json({ ok: false, error: "缺少切换原因" }, { status: 400 });

    const rollout = new CapabilityFoundationRollout(getDb());
    const epoch = body.action === "shadow"
      ? rollout.beginShadow(reason)
      : body.action === "cutover"
        ? rollout.cutover(reason)
        : body.action === "rollback"
          ? rollout.rollback(reason)
          : null;
    if (!epoch) return NextResponse.json({ ok: false, error: "不支持的切换动作" }, { status: 400 });
    return NextResponse.json({ ok: true, epoch });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "切换失败" },
      { status: 500 },
    );
  }
}
