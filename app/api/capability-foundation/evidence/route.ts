import { NextRequest, NextResponse } from "next/server";
import { isTrustedLocalMutation } from "@/lib/api/local-request";
import { getDb } from "@/lib/db/sqlite";
import { exportFoundationEvidenceChain, listFoundationClaims } from "@/lib/observability/foundation-operations";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isTrustedLocalMutation(request)) return NextResponse.json({ ok: false, error: "cross-site request rejected" }, { status: 403 });
  try {
    const claimId = request.nextUrl.searchParams.get("claimId");
    if (!claimId) {
      return NextResponse.json({ ok: true, data: { claims: listFoundationClaims(getDb(), {
        caseId: request.nextUrl.searchParams.get("caseId") ?? undefined,
        limit: Number(request.nextUrl.searchParams.get("limit") ?? 100),
      }) } });
    }
    const includeContent = request.nextUrl.searchParams.get("includeContent") === "true";
    const data = exportFoundationEvidenceChain(getDb(), claimId, includeContent);
    const response = NextResponse.json({ ok: true, data });
    if (request.nextUrl.searchParams.get("download") === "true") {
      const safeClaimId = claimId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
      response.headers.set("Content-Disposition", `attachment; filename="evidence-${safeClaimId}.json"`);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "证据链读取失败";
    return NextResponse.json({ ok: false, error: message }, { status: /not found/.test(message) ? 404 : 400 });
  }
}
