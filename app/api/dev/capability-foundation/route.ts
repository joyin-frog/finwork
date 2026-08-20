import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/sqlite";
import { captureFoundationDiagnostics } from "@/lib/observability/foundation-diagnostics";

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
