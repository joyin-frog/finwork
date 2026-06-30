import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isTrustedLocalMutation } from "@/lib/api/local-request";
import { exportDiagnostics } from "@/lib/runtime/diagnostics";
import { getAppDataDir } from "@/lib/runtime/paths";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isTrustedLocalMutation(req)) {
    return NextResponse.json({ ok: false, error: "cross-site request rejected" }, { status: 403 });
  }

  try {
    const result = exportDiagnostics(path.join(getAppDataDir(), "diagnostics"));
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "diagnostics export failed" },
      { status: 500 }
    );
  }
}
