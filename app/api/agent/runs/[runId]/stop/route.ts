import { NextResponse } from "next/server";
import { getAgentRun } from "@/lib/db/run-store";
import { abortRunById } from "@/lib/agent/run-abort-registry";
import { isTerminalRunStatus } from "@/lib/agent/run-contract";
import { createEmitter } from "@/lib/agent/runtime-events";
import { persistRuntimeEnvelope } from "@/lib/agent/run-event-persistence";

/**
 * POST /api/agent/runs/:runId/stop
 * CR-R2：用户显式停止的唯一入口（不依赖浏览器 SSE abort）。
 * 先发 state_changed + settled，再 abort 活进程；状态由 appendDurableRunEvent 写入。
 */
export async function POST(
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

  if (isTerminalRunStatus(run.status)) {
    return NextResponse.json({
      ok: true,
      data: { runId, status: run.status, alreadyTerminal: true },
    });
  }

  // 尽力先落账本，再 abort（abort 触发 query catch 时已是终态 → settle 幂等跳过）
  try {
    const emitter = createEmitter(run.traceId, run.conversationId);
    const changed = emitter.wrap({
      type: "run_state_changed",
      from: run.status,
      to: "canceled",
      trigger: "explicit_stop_quiesced",
      terminationReason: "user_stop",
    });
    persistRuntimeEnvelope(changed, {
      runId,
      completedToolCallIds: [],
      generatedFiles: [],
      status: run.status,
    });
    const settled = emitter.wrap({ type: "run_settled", outcome: "aborted" });
    persistRuntimeEnvelope(settled, {
      runId,
      completedToolCallIds: [],
      generatedFiles: [],
      status: "canceled",
    });
  } catch {
    /* best-effort */
  }

  const aborted = abortRunById(runId);
  const after = getAgentRun(runId);

  return NextResponse.json({
    ok: true,
    data: { runId, status: after?.status ?? "canceled", abortedLive: aborted },
  });
}
