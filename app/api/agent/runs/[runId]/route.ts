import { NextResponse } from "next/server";
import { getAgentRun, RUN_REPLAY_SCHEMA_VERSION } from "@/lib/db/run-store";

/**
 * GET /api/agent/runs/:runId
 * CR-R1 重放：返回 Run 快照（含 checkpoint）。不存在 → 404（不泄漏）。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const run = getAgentRun(runId);
  if (!run) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    schemaVersion: RUN_REPLAY_SCHEMA_VERSION,
    data: { run },
  });
}
