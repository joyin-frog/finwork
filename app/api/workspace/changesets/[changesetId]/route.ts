import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { getFileWorkspaceStore, resolveFileChangeSet } from "@/lib/file-workspace";
import { authorizedByDesktop } from "@/lib/file-workspace/desktop-auth";

type ChangeSetRow = {
  changeset_id: string;
  run_id: string;
  asset_id: string;
  base_version_id: string | null;
  candidate_version_id: string;
  diff_kind: string;
  diff_json: string;
  validation_json: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
};

export async function GET(_request: Request, { params }: { params: Promise<{ changesetId: string }> }) {
  const { changesetId } = await params;
  const row = readChangeSet(changesetId);
  if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, data: publicChangeSet(row) });
}

export async function POST(request: Request, { params }: { params: Promise<{ changesetId: string }> }) {
  if (!await authorizedByDesktop(request)) {
    return NextResponse.json({ ok: false, error: "文件变更只能由 Finwork 桌面复核操作确认" }, { status: 403 });
  }
  try {
    const { changesetId } = await params;
    const body = await request.json() as { decision?: "approved" | "rejected" };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return NextResponse.json({ ok: false, error: "决定无效" }, { status: 400 });
    }
    const before = readChangeSet(changesetId);
    if (!before) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const validation = parseJson(before.validation_json);
    if (body.decision === "approved" && validation.readyForUser !== true) {
      return NextResponse.json({ ok: false, error: "该变更尚未通过模型与确定性复核" }, { status: 409 });
    }
    resolveFileChangeSet(getDb(), changesetId, body.decision);
    if (body.decision === "approved") {
      const store = await getFileWorkspaceStore();
      store.applyApprovedChangeSet(changesetId);
    }
    const after = readChangeSet(changesetId)!;
    return NextResponse.json({ ok: true, data: publicChangeSet(after) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function readChangeSet(changesetId: string): ChangeSetRow | undefined {
  return getDb().prepare(`
    SELECT changeset_id,run_id,asset_id,base_version_id,candidate_version_id,
           diff_kind,diff_json,validation_json,status,created_at,resolved_at
    FROM file_changesets WHERE changeset_id=?
  `).get(changesetId) as ChangeSetRow | undefined;
}

function publicChangeSet(row: ChangeSetRow) {
  return {
    changesetId: row.changeset_id,
    runId: row.run_id,
    assetId: row.asset_id,
    baseVersionId: row.base_version_id,
    candidateVersionId: row.candidate_version_id,
    diffKind: row.diff_kind,
    diff: parseJson(row.diff_json),
    validation: parseJson(row.validation_json),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function parseJson(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; }
  catch { return {}; }
}
