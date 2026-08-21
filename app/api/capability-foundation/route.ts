import { NextResponse } from "next/server";

import { withApiError } from "@/lib/api/with-api-error";
import { getDb } from "@/lib/db/sqlite";
import { getFoundationManagementSnapshot } from "@/lib/observability/foundation-read-model";

export const dynamic = "force-dynamic";

export const GET = withApiError(async () => {
  return NextResponse.json({ ok: true, snapshot: getFoundationManagementSnapshot(getDb()) });
}, "/api/capability-foundation");
