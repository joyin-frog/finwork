import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/sqlite";
import { captureFoundationDiagnostics } from "@/lib/observability/foundation-diagnostics";
import { CapabilityFoundationRollout } from "@/lib/runtime/capability-foundation-rollout";

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
    const body = await request.json() as { action?: string; reason?: string };
    const reason = body.reason?.trim() ?? "";
    if (body.action !== "ensure") {
      return NextResponse.json(
        { ok: false, error: "shadow/legacy 切换已退役；生产环境仅允许 Capability Foundation 权威" },
        { status: 410 },
      );
    }
    const rollout = new CapabilityFoundationRollout(getDb());
    const epoch = rollout.ensureInitialized(reason || "developer authority assertion");
    return NextResponse.json({ ok: true, epoch });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "切换失败" },
      { status: 500 },
    );
  }
}
