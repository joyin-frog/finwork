import { NextResponse } from "next/server";
import { getConversationAttachments } from "@/lib/db/sqlite";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const conversationId = Number(url.searchParams.get("conversationId"));
  if (!conversationId) {
    return NextResponse.json({ ok: false, error: "Missing conversationId" }, { status: 400 });
  }
  const attachments = getConversationAttachments(conversationId);
  return NextResponse.json({ ok: true, data: { attachments } });
}
