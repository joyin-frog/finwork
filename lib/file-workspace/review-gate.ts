import type { DatabaseSync } from "node:sqlite";

export type WorkspaceReviewGate =
  | { ok: true; changesetId: string; candidateVersionId: string; candidateName: string }
  | { ok: false; code: "workspace_review_missing" | "workspace_review_failed"; message: string };

/**
 * finalize 前的权威文件复核门。只承认当前 run 中最后一次工作簿复核：
 * 新路径由 patch_workspace_workbook 自动形成内部计划，旧路径仍兼容显式 review。
 * 脚本/JSON 等普通输出 changeset 不得遮蔽工作簿候选。
 */
export function workspaceReviewGate(db: DatabaseSync, runId: string): WorkspaceReviewGate {
  const rows = db.prepare(`
    SELECT changeset_id,candidate_version_id,validation_json,status
    FROM file_changesets WHERE run_id=?
    ORDER BY created_at DESC,rowid DESC
  `).all(runId) as Array<{
    changeset_id: string;
    candidate_version_id: string;
    validation_json: string;
    status: string;
  }>;
  // Script revisions and generated JSON evidence also create changesets. They
  // must not shadow the authoritative workbook review. Select the latest row
  // that actually represents a workbook review, then fail closed on that row.
  const row = rows.find((candidate) => {
    try {
      const parsed = JSON.parse(candidate.validation_json) as { kind?: unknown; requestedFinal?: unknown };
      return parsed.kind === "harness_managed_workbook_edit"
        || parsed.kind === "workspace_change_review"
        || Object.hasOwn(parsed, "requestedFinal");
    } catch {
      return false;
    }
  });
  if (!row) {
    return {
      ok: false,
      code: "workspace_review_missing",
      message: "尚未形成候选文件复核记录，禁止进入 finalize",
    };
  }
  let validation: {
    kind?: unknown;
    complete?: unknown;
    planId?: unknown;
    requestedFinal?: unknown;
    candidateName?: unknown;
  } = {};
  try {
    validation = JSON.parse(row.validation_json) as typeof validation;
  } catch {
    // malformed evidence is a failed gate
  }
  const accepted = validation.complete === true
    && validation.requestedFinal === true
    && typeof validation.planId === "string"
    && /^[0-9a-f-]{36}$/i.test(validation.planId)
    && typeof validation.candidateName === "string"
    && validation.candidateName.trim().length > 0
    && ["pending", "approved", "applied"].includes(row.status);
  if (!accepted) {
    return {
      ok: false,
      code: "workspace_review_failed",
      message: "最新候选文件复核未通过，禁止进入 finalize",
    };
  }
  return {
    ok: true,
    changesetId: row.changeset_id,
    candidateVersionId: row.candidate_version_id,
    candidateName: validation.candidateName as string,
  };
}
