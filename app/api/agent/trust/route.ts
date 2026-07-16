import { NextResponse } from "next/server";
import { listTrustedTools, revokeToolTrust } from "@/lib/agent/hooks/session-trust";

/** GET /api/agent/trust?conversationId=N
 *  返回该会话当前被信任的工具名列表。
 *  conversationId 非正整数 → 400。 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("conversationId");
  const conversationId = raw != null ? Number(raw) : NaN;
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ ok: false, error: "conversationId 必须为正整数" }, { status: 400 });
  }
  const tools = listTrustedTools(conversationId);
  return NextResponse.json({ ok: true, data: { tools } });
}

/** DELETE /api/agent/trust
 *  body: { conversationId: number, toolName: string }
 *  撤销指定会话对指定工具的信任。参数不合法 → 400。 */
export async function DELETE(request: Request) {
  let body: { conversationId?: unknown; toolName?: unknown };
  try {
    body = (await request.json()) as { conversationId?: unknown; toolName?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const conversationId = typeof body.conversationId === "number" ? body.conversationId : NaN;
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return NextResponse.json({ ok: false, error: "conversationId 必须为正整数" }, { status: 400 });
  }
  if (typeof body.toolName !== "string" || !body.toolName) {
    return NextResponse.json({ ok: false, error: "toolName 必填" }, { status: 400 });
  }
  revokeToolTrust(conversationId, body.toolName);
  return NextResponse.json({ ok: true });
}
