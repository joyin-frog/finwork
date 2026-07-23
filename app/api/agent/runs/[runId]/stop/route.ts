import { NextResponse } from "next/server";
import { appendTerminalRunEventPair, getAgentRun } from "@/lib/db/run-store";
import { abortRunById } from "@/lib/agent/run-abort-registry";
import { isTerminalRunStatus } from "@/lib/agent/run-contract";
import { createEmitter } from "@/lib/agent/runtime-events";

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

  // 先原子落账本，再 abort（abort 触发 query catch 时已是终态 → settle 幂等跳过）
  try {
    const emitter = createEmitter(run.traceId, run.conversationId);
    const changed = emitter.wrap({
      type: "run_state_changed",
      from: run.status,
      to: "canceled",
      trigger: "explicit_stop_quiesced",
      terminationReason: "user_stop",
    });
    const settled = emitter.wrap({ type: "run_settled", outcome: "aborted" });
    appendTerminalRunEventPair(changed, settled);
  } catch (error) {
    // 用户的停止意图优先：即使终态落账失败，也必须尽力终止真实执行。
    const aborted = abortRunById(runId);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "stop persistence failed",
        data: {
          runId,
          status: getAgentRun(runId)?.status ?? run.status,
          abortedLive: aborted,
          persistenceFailed: true,
        },
      },
      { status: 500 },
    );
  }

  const aborted = abortRunById(runId);
  const after = getAgentRun(runId);

  return NextResponse.json({
    ok: true,
    data: { runId, status: after?.status ?? "canceled", abortedLive: aborted },
  });
}
