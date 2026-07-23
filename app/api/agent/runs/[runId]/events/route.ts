import { NextResponse } from "next/server";
import {
  getAgentRun,
  listRunEventsAfter,
  RUN_REPLAY_SCHEMA_VERSION,
} from "@/lib/db/run-store";

/**
 * GET /api/agent/runs/:runId/events?afterEventId=N&limit=M
 * CR-R1：按持久 cursor 增量重放（afterEventId 排他）。
 */
export async function GET(
  request: Request,
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

  const url = new URL(request.url);
  const afterRaw = url.searchParams.get("afterEventId");
  const limitRaw = url.searchParams.get("limit");
  const afterEventId = afterRaw != null && afterRaw !== "" ? Number(afterRaw) : 0;
  const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : 100;
  if (!Number.isFinite(afterEventId) || afterEventId < 0) {
    return NextResponse.json({ ok: false, error: "invalid afterEventId" }, { status: 400 });
  }
  if (!Number.isFinite(limit) || limit < 1) {
    return NextResponse.json({ ok: false, error: "invalid limit" }, { status: 400 });
  }

  const { events, nextEventId } = listRunEventsAfter(runId, afterEventId, limit);

  return NextResponse.json({
    ok: true,
    schemaVersion: RUN_REPLAY_SCHEMA_VERSION,
    data: {
      events,
      nextEventId,
      lastEventId: run.lastEventId,
    },
  });
}
