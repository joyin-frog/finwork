import { NextRequest, NextResponse } from "next/server";
import { isTrustedLocalMutation } from "@/lib/api/local-request";
import { getDb } from "@/lib/db/sqlite";
import { getFoundationCase, listFoundationCases } from "@/lib/observability/foundation-operations";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isTrustedLocalMutation(request)) return NextResponse.json({ ok: false, error: "cross-site request rejected" }, { status: 403 });
  try {
    const caseId = request.nextUrl.searchParams.get("caseId");
    const data = caseId
      ? getFoundationCase(getDb(), caseId)
      : { cases: listFoundationCases(getDb(), Number(request.nextUrl.searchParams.get("limit") ?? 100)) };
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "案件读取失败";
    return NextResponse.json({ ok: false, error: message }, { status: /not found/.test(message) ? 404 : 400 });
  }
}
