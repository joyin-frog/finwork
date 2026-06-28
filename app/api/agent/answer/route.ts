import { NextResponse } from "next/server";
import { answerPendingQuestion } from "@/lib/agent/pending-questions";

export async function POST(request: Request) {
  let body: { questionId?: string; answer?: string };
  try {
    body = (await request.json()) as { questionId?: string; answer?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (!body.questionId || typeof body.answer !== "string") {
    return NextResponse.json({ ok: false, error: "questionId 与 answer 必填" }, { status: 400 });
  }
  const resolved = answerPendingQuestion(body.questionId, body.answer);
  if (!resolved) {
    return NextResponse.json({ ok: false, error: "该确认已失效(可能已超时或会话已结束)" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
