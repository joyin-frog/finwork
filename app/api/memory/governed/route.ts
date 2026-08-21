import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isTrustedLocalMutation } from "@/lib/api/local-request";
import { getDb } from "@/lib/db/sqlite";
import {
  correctManualMemoryContent,
  correctGovernedMemory,
  createGovernedMemoryCandidate,
  createManualMemoryConflictKey,
  createManualMemoryContent,
  GovernedMemoryStore,
  readManualMemoryContent,
} from "@/lib/memory-v2";

const PRINCIPAL = { id: "local-user", type: "user" as const, tenantId: "local" };
const StatusSchema = z.enum(["candidate", "approved", "rejected", "expired", "archived"]);
const KindSchema = z.enum(["working", "episodic", "semantic", "procedural", "feedback"]);

const CreateSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  topic: z.string().trim().min(1).max(120).optional(),
  kind: KindSchema.default("semantic"),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  expiresAt: z.string().datetime().optional(),
}).strict();

const UpdateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    memoryId: z.string().trim().min(1),
    supersedeIds: z.array(z.string().trim().min(1)).default([]),
    reason: z.string().trim().min(1).max(2_000).default("用户在记忆设置中批准"),
  }).strict(),
  z.object({
    action: z.literal("reject"),
    memoryId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(2_000).default("用户在记忆设置中拒绝"),
  }).strict(),
  z.object({
    action: z.literal("archive"),
    memoryId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(2_000).default("用户在记忆设置中归档"),
  }).strict(),
  z.object({
    action: z.literal("restore"),
    memoryId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(2_000).default("用户在记忆设置中恢复归档"),
  }).strict(),
  z.object({
    action: z.literal("correct"),
    memoryId: z.string().trim().min(1),
    content: z.string().trim().min(1).max(20_000),
    reason: z.string().trim().min(1).max(2_000).default("用户在记忆设置中纠正"),
  }).strict(),
]);

const DeleteSchema = z.object({
  memoryId: z.string().trim().min(1),
  retentionReason: z.string().trim().min(1).max(2_000).optional(),
}).strict();

function rejectUntrusted(request: NextRequest): NextResponse | undefined {
  if (isTrustedLocalMutation(request)) return undefined;
  return NextResponse.json({ ok: false, error: "cross-site request rejected" }, { status: 403 });
}

function parseCsv<T extends string>(raw: string | null, schema: z.ZodType<T>): T[] {
  if (!raw) return [];
  return raw.split(",").filter(Boolean).map((value) => schema.parse(value));
}

function errorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "记忆操作失败";
  return NextResponse.json(
    { ok: false, error: message },
    { status: /not found/.test(message) ? 404 : 400 },
  );
}

export async function GET(request: NextRequest) {
  const rejected = rejectUntrusted(request);
  if (rejected) return rejected;
  try {
    const store = new GovernedMemoryStore(getDb());
    const records = store.list({
      statuses: parseCsv(request.nextUrl.searchParams.get("status"), StatusSchema),
      kinds: parseCsv(request.nextUrl.searchParams.get("kind"), KindSchema),
      tenantId: "local",
      principalId: "local-user",
      search: request.nextUrl.searchParams.get("q") ?? undefined,
      limit: Number(request.nextUrl.searchParams.get("limit") ?? 200),
    });
    const accessLog = store.listAccessLog({ limit: 100 });
    const retentionDecisions = store.listRetentionDecisions({
      memoryIds: records.map((record) => record.id),
      limit: 200,
    });
    return NextResponse.json({ ok: true, data: { records, accessLog, retentionDecisions } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const rejected = rejectUntrusted(request);
  if (rejected) return rejected;
  try {
    const body = CreateSchema.parse(await request.json());
    const now = new Date().toISOString();
    const db = getDb();
    const memoryId = randomUUID();
    const topic = body.topic ?? body.content.slice(0, 120);
    const store = new GovernedMemoryStore(db);
    const duplicate = store.findExactSummary({
      summary: body.content,
      tenantId: "local",
      principalId: "local-user",
    })[0];
    if (duplicate) throw new Error(`memory already exists: ${duplicate.id}`);
    const { record, source: captured } = createGovernedMemoryCandidate(db, {
      content: body.content,
      principal: PRINCIPAL,
      sensitivity: body.sensitivity,
      at: now,
      candidate: {
        conflictKey: createManualMemoryConflictKey(body.kind, topic),
        record: {
          id: memoryId,
          kind: body.kind,
          scope: { tenantId: "local", principalId: "local-user" },
          entityRefs: [],
          content: createManualMemoryContent(topic, body.content),
          confidence: 1,
          sensitivity: body.sensitivity,
          createdAt: now,
          expiresAt: body.expiresAt,
          owner: PRINCIPAL,
        },
      },
    });
    return NextResponse.json({
      ok: true,
      data: {
        record,
        sourceRef: captured.evidence.id,
        sourceArtifactVersionId: captured.artifact.versionId,
        sourceCaseId: captured.caseId,
      },
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const rejected = rejectUntrusted(request);
  if (rejected) return rejected;
  try {
    const body = UpdateSchema.parse(await request.json());
    const db = getDb();
    const store = new GovernedMemoryStore(db);
    const now = new Date().toISOString();
    const record = body.action === "approve"
      ? store.approve({
          memoryId: body.memoryId,
          approver: PRINCIPAL,
          supersedeIds: body.supersedeIds,
          reason: body.reason,
          at: now,
        })
      : body.action === "reject"
        ? store.reject(body.memoryId, PRINCIPAL, body.reason, now)
        : body.action === "archive"
          ? store.archive(body.memoryId, PRINCIPAL, body.reason, now)
          : body.action === "restore"
            ? store.restoreArchived(body.memoryId, PRINCIPAL, body.reason, now)
            : (() => {
            const current = store.get(body.memoryId);
            if (!current) throw new Error(`memory not found: ${body.memoryId}`);
            if (body.content === readManualMemoryContent(current.content).summary) {
              throw new Error("correction must change content");
            }
            return correctGovernedMemory(db, {
              memoryId: body.memoryId,
              sourceContent: body.content,
              correctedContent: correctManualMemoryContent(current.content, body.content),
              principal: PRINCIPAL,
              sensitivity: current.sensitivity,
              reason: body.reason,
              at: now,
            }).record;
              })();
    return NextResponse.json({ ok: true, data: { record } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const rejected = rejectUntrusted(request);
  if (rejected) return rejected;
  try {
    const body = DeleteSchema.parse(await request.json());
    const result = new GovernedMemoryStore(getDb()).requestDeletion({
      memoryId: body.memoryId,
      requester: PRINCIPAL,
      retentionReason: body.retentionReason,
      at: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
