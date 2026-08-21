import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { getAgentRun } from "@/lib/db/run-store";
import { getInterruptedRunResumeContract } from "@/lib/task/recovery";
import { WorkPlanStore } from "@/lib/task/work-plan";

export const dynamic = "force-dynamic";

/** Stable read-only contract for a future plan UI. It exposes no tool arguments or hidden reasoning. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  const run = runId ? getAgentRun(runId) : null;
  if (!run) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  const db = getDb();
  const plans = new WorkPlanStore(db);
  const plan = plans.getByRunId(runId);
  if (!plan) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    schemaVersion: 1,
    data: {
      plan,
      preflight: plans.listPreflight(plan.caseId),
      recovery: run.status === "paused" ? getInterruptedRunResumeContract(db, runId) : null,
    },
  });
}
