import { NextResponse } from "next/server";
import { runTelemetryReport, runTelemetryTestReport } from "@/lib/telemetry/reporter";

/**
 * POST /api/telemetry/report
 * 启动触发上报。节流已在 reporter 内实现(每天最多一次)。
 * fire-and-forget:客户端不等响应,错误静默。
 *
 * 可选 body { force: true } → 强制测试上报(跳过节流,不改本地状态),await 结果返回 200。
 */
export async function POST(request: Request) {
  let force = false;
  try {
    const body = (await request.json()) as { force?: boolean };
    force = body.force === true;
  } catch {
    // body 为空或非 JSON(如 app-shell 无 body 调用)→ force 保持 false
  }

  if (force) {
    const result = await runTelemetryTestReport();
    return NextResponse.json(result, { status: 200 });
  }

  // 不 await:让上报在后台完成,立即返回 202。
  void runTelemetryReport();
  return NextResponse.json({ ok: true }, { status: 202 });
}
