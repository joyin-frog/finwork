import { NextResponse } from "next/server";
import { summarizeExpenses } from "@/lib/domain/analysis";
import { withApiError } from "@/lib/api/with-api-error";

export const POST = withApiError(async function POST(request: Request) {
  const body = (await request.json()) as {
    rows: Array<{ category?: string; amount?: number }>;
  };

  return NextResponse.json({
    ok: true,
    data: summarizeExpenses(body.rows ?? []),
    audit: ["按费用类目汇总，并标记占比最高的类目"]
  });
}, "/api/analysis/summary");
