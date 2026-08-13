import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isTrustedLocalMutation } from "@/lib/api/local-request";
import { getDb } from "@/lib/db/sqlite";
import {
  artifactLifecycleService,
  getFoundationArtifact,
  listFoundationArtifacts,
  loadGcPlan,
} from "@/lib/observability/foundation-operations";

export const dynamic = "force-dynamic";

const LifecycleActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("dry_run"), minimumAgeMs: z.number().int().nonnegative().default(86_400_000),
    gracePeriodMs: z.number().int().nonnegative().default(604_800_000), lowWatermarkBytes: z.number().int().nonnegative().nullable().default(null),
  }).strict(),
  z.object({ action: z.literal("tombstone"), runId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("restore"), versionId: z.string().trim().min(1) }).strict(),
  z.object({
    action: z.literal("hold"), versionId: z.string().trim().min(1), type: z.enum(["legal_hold", "pin"]),
    reason: z.string().trim().min(1).max(2000), expiresAt: z.string().datetime().optional(),
  }).strict(),
  z.object({ action: z.literal("release_hold"), holdId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("sweep"), confirm: z.literal("DELETE_EXPIRED_ARTIFACTS") }).strict(),
]);

function rejected(request: NextRequest) {
  return isTrustedLocalMutation(request) ? undefined : NextResponse.json({ ok: false, error: "cross-site request rejected" }, { status: 403 });
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "文件生命周期操作失败";
  return NextResponse.json({ ok: false, error: message }, { status: /not found/.test(message) ? 404 : 400 });
}

export async function GET(request: NextRequest) {
  const denied = rejected(request); if (denied) return denied;
  try {
    const artifactId = request.nextUrl.searchParams.get("artifactId");
    const data = artifactId ? getFoundationArtifact(getDb(), artifactId) : {
      artifacts: listFoundationArtifacts(getDb(), {
        caseId: request.nextUrl.searchParams.get("caseId") ?? undefined,
        state: request.nextUrl.searchParams.get("state") ?? undefined,
        limit: Number(request.nextUrl.searchParams.get("limit") ?? 100),
      }),
    };
    return NextResponse.json({ ok: true, data });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const denied = rejected(request); if (denied) return denied;
  try {
    const body = LifecycleActionSchema.parse(await request.json());
    const db = getDb();
    const service = artifactLifecycleService(db);
    const now = new Date().toISOString();
    let data: unknown;
    switch (body.action) {
      case "dry_run": {
        const plan = service.plan({ now, minimumAgeMs: body.minimumAgeMs, gracePeriodMs: body.gracePeriodMs, lowWatermarkBytes: body.lowWatermarkBytes, actorId: "local-user" });
        data = { plan, quota: service.quotaSnapshot(plan) };
        break;
      }
      case "tombstone": {
        const stored = loadGcPlan(db, body.runId);
        service.tombstone(stored.plan, { ...stored.policy, now, actorId: "local-user" });
        data = { runId: body.runId, tombstoned: stored.plan.candidates.length };
        break;
      }
      case "restore": service.restore(body.versionId, "local-user", now); data = { versionId: body.versionId }; break;
      case "hold": data = { holdId: service.hold(body.versionId, { type: body.type, ownerId: "local-user", reason: body.reason, expiresAt: body.expiresAt, now }) }; break;
      case "release_hold": service.releaseHold(body.holdId, "local-user", now); data = { holdId: body.holdId }; break;
      case "sweep": data = service.sweep(now, "local-user"); break;
    }
    return NextResponse.json({ ok: true, data });
  } catch (error) { return failure(error); }
}
