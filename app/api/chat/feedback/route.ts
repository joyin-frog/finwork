import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  upsertChatFeedback,
  listFeedbackForConversation,
} from "@/lib/db/sqlite";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体解析失败" }, { status: 400 });
  }

  const { messageId, rating, reason } = body as Record<string, unknown>;

  if (typeof messageId !== "number") {
    return NextResponse.json({ ok: false, error: "messageId 必须为数字" }, { status: 400 });
  }
  if (rating !== "up" && rating !== "down") {
    return NextResponse.json({ ok: false, error: "rating 必须为 up 或 down" }, { status: 400 });
  }

  const db = getDb();

  // 验证 messageId 存在
  const msgRow = db.prepare("SELECT id, conversation_id FROM chat_messages WHERE id = ?").get(messageId) as
    | { id: number; conversation_id: number }
    | undefined;
  if (!msgRow) {
    return NextResponse.json({ ok: false, error: "消息不存在" }, { status: 404 });
  }

  // 推导 trace_id：取该消息事件中最早的非空 trace_id
  const traceRow = db.prepare(
    "SELECT trace_id FROM chat_agent_events WHERE message_id = ? AND trace_id IS NOT NULL ORDER BY id ASC LIMIT 1"
  ).get(messageId) as { trace_id: string } | undefined;
  const traceId = traceRow?.trace_id ?? null;

  upsertChatFeedback({
    messageId,
    conversationId: msgRow.conversation_id,
    traceId,
    rating: rating as "up" | "down",
    reason: typeof reason === "string" ? reason : null,
  });

  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const conversationId = Number(url.searchParams.get("conversationId"));
  if (!conversationId || isNaN(conversationId)) {
    return NextResponse.json({ ok: false, error: "conversationId 必须为数字" }, { status: 400 });
  }

  const list = listFeedbackForConversation(conversationId);
  // 返回 messageId → {rating, reason} 映射
  const feedbackMap: Record<number, { rating: "up" | "down"; reason: string | null }> = {};
  for (const item of list) {
    feedbackMap[item.messageId] = { rating: item.rating, reason: item.reason };
  }

  return NextResponse.json({ ok: true, data: { feedback: feedbackMap } });
}
