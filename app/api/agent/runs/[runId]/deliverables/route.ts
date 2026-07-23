import { NextResponse } from "next/server";
import { getAgentRun } from "@/lib/db/run-store";
import { getDb } from "@/lib/db/sqlite";
import { SqliteDeliverableStore } from "@/lib/deliverable/store";
import { attachmentStateFromStatus } from "@/lib/deliverable/types";

/**
 * GET /api/agent/runs/:runId/deliverables
 * CR-R2：附件质量展示数据源。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const run = getAgentRun(runId);
  if (!run) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  try {
    const store = new SqliteDeliverableStore(getDb());
    const rows = store.listByRun(runId).map((r) => ({
      ...r,
      qualityState: attachmentStateFromStatus(r.status),
    }));
    return NextResponse.json({ ok: true, data: { runId, deliverables: rows } });
  } catch {
    return NextResponse.json({ ok: true, data: { runId, deliverables: [] } });
  }
}
