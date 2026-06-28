import { NextRequest, NextResponse } from "next/server";
import { recordAppError, AppErrorKind } from "@/lib/runtime/app-errors";

const VALID_KINDS = new Set<AppErrorKind>(["render", "rejection", "unhandled", "api", "server"]);

/**
 * POST /api/errors
 * 客户端/服务端错误上报内部接口(非遥测契约端,不对外)。
 * 收 {kind, source, message, stack} → recordAppError(再次脱敏,纵深防御) → 返回 200。
 *
 * 红线 7 合规驻留:再次脱敏,不透传原始错误出应用外。
 * 红线 8 审计落点:经 app_errors 表留存,随批次上报后标 reported=1。
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = VALID_KINDS.has(body.kind as AppErrorKind)
      ? (body.kind as AppErrorKind)
      : "unhandled";
    const source = String(body.source ?? "client").slice(0, 200);
    const message = String(body.message ?? "").slice(0, 2000); // 让 recordAppError 再截断
    const stack = body.stack ? String(body.stack).slice(0, 5000) : null;

    recordAppError({ kind, source, message, stack });

    return NextResponse.json({ ok: true });
  } catch {
    // 不能让错误上报接口自身再抛出错误(循环风险)
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
