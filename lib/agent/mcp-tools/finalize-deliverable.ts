import { z } from "zod/v4";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { DeliverySpec } from "@/lib/agent/run-contract";
import {
  FINALIZED_MARKER,
  finalizeDeliverables,
  MemoryDeliverableStore,
  SqliteDeliverableStore,
  type DeliverableStore,
  type FinalizeDeps,
  type FinalizeFile,
} from "@/lib/deliverable";
import type { SdkLike } from "./sdk-types";
import { withFileMutationQueue } from "@/lib/agent/tools/file-mutation-queue";
import { getDb } from "@/lib/db/sqlite";
import {
  getFileWorkspaceStore,
  recordGeneratedOutputVersion,
  workspaceReviewGate,
  type FileWorkspaceStore,
} from "@/lib/file-workspace";
import { getRunFileWorkspacePaths } from "@/lib/runtime/paths";

type Sdk = SdkLike;

export { FINALIZED_MARKER };

export type FinalizeDeliverableToolOptions = {
  runId?: string;
  deliverySpec?: DeliverySpec | (() => DeliverySpec | null | undefined);
  conversationFilesDir?: string;
  conversationId?: number;
  messageId?: number;
  deps?: FinalizeDeps;
  /** 受管表格修改必须先通过 final workspace review。 */
  requireWorkspaceChangeReview?: boolean;
};

function defaultStore(): DeliverableStore {
  try {
    // 延迟 import，避免工具加载期强依赖 DB 初始化顺序
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db/sqlite") as typeof import("@/lib/db/sqlite");
    const db = getDb();
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deliverables'")
      .get();
    if (has) return new SqliteDeliverableStore(db);
  } catch {
    /* fall through */
  }
  return new MemoryDeliverableStore();
}

/**
 * Delivery validation may recalculate a workbook in place (for example through
 * LibreOffice).  Keep that recalculated byte stream on the reviewed asset's
 * version branch so a later repair cannot accidentally start from stale,
 * pre-recalculation bytes.
 */
export async function syncFinalizedWorkspaceCandidate(input: {
  db: DatabaseSync;
  store: FileWorkspaceStore;
  runId: string;
  candidatePath: string;
}): Promise<{ changed: boolean; versionId: string }> {
  const review = workspaceReviewGate(input.db, input.runId);
  if (!review.ok) throw new Error(review.message);
  const content = await readFile(input.candidatePath);
  if (input.store.readVersion(review.candidateVersionId).equals(content)) {
    return { changed: false, versionId: review.candidateVersionId };
  }
  const row = input.db.prepare(
    "SELECT asset_id FROM file_changesets WHERE changeset_id=?",
  ).get(review.changesetId) as { asset_id: string } | undefined;
  if (!row) throw new Error(`文件复核记录不存在: ${review.changesetId}`);
  const asset = input.store.getAsset(row.asset_id);
  const recalculated = input.store.ingestManagedBuffer({
    assetId: row.asset_id,
    name: asset.name,
    mediaType: asset.mediaType,
    content,
    sourceKind: "managed",
    parentVersionId: review.candidateVersionId,
    makeCurrent: false,
  });
  const updated = input.db.prepare(`
    UPDATE file_changesets SET candidate_version_id=?
    WHERE changeset_id=? AND candidate_version_id=?
  `).run(recalculated.versionId, review.changesetId, review.candidateVersionId);
  if (Number(updated.changes) !== 1) {
    throw new Error("stale_base_version: finalize 重算时候选分支头已变化");
  }
  input.store.linkTaskFile(input.runId, recalculated.assetId, recalculated.versionId, "output");
  return { changed: true, versionId: recalculated.versionId };
}

/**
 * finalize_deliverable — CR-Q1 质量门。
 * 入参 FinalizeFile{name, contractDeliverableId}；只提交 CompletionEvidence，绝不写 Run completed。
 */
export function createFinalizeDeliverableTool(
  sdk: Sdk,
  outputDir: string,
  options: FinalizeDeliverableToolOptions = {}
) {
  return sdk.tool(
    "finalize_deliverable",
    [
      "一次回答结束、文件产物已定稿时调用：声明最终交付文件及其合同 deliverable id。",
      "系统按 DeliverySpec 做存在性/类型/可打开性/表格重算等校验，通过后复制到不可变 delivered/ 并提交 CompletionEvidence。",
      "不要传 kind/profile/mime 覆盖字段——质量档位以合同为准。",
      "验证失败时工作文件与报告保留；未通过质量门的文件不会成为正式附件。",
      "每次回答最多调用一次，放在最后一步。",
    ].join("\n"),
    {
      files: z
        .array(
          z.object({
            name: z.string().min(1).describe("最终交付文件名（basename，不要写路径）"),
            contractDeliverableId: z
              .string()
              .min(1)
              .describe("DeliverySpec.requiredDeliverables[].id"),
          })
        )
        .min(1)
        .describe('如 [{ "name": "科目表差异汇总.xlsx", "contractDeliverableId": "workbook" }]'),
    },
    async (args: { files: FinalizeFile[] }) => {
      try {
        const contract =
          typeof options.deliverySpec === "function"
            ? options.deliverySpec()
            : options.deliverySpec;
        if (!contract) {
          return {
            content: [
              {
                type: "text" as const,
                text: "DeliverySpec 未接线，无法 finalize。请由系统注入合同后再声明交付物。",
              },
            ],
            isError: true as const,
            structuredContent: { code: "missing_delivery_spec" },
          };
        }

        const runId = options.runId?.trim() || `run-${randomUUID()}`;
        if (options.requireWorkspaceChangeReview) {
          const review = workspaceReviewGate(getDb(), runId);
          if (!review.ok) {
            return {
              content: [{ type: "text" as const, text: review.message }],
              isError: true as const,
              structuredContent: { code: review.code },
            };
          }
          const finalizedNames = new Set(args.files.map((file) => path.basename(file.name)));
          if (!finalizedNames.has(path.basename(review.candidateName))) {
            return {
              content: [{
                type: "text" as const,
                text: `finalize 文件必须是最新复核候选 ${review.candidateName}，禁止提交未复核文件。`,
              }],
              isError: true as const,
              structuredContent: {
                code: "workspace_review_candidate_mismatch",
                reviewedCandidateName: review.candidateName,
              },
            };
          }
        }
        const store = options.deps?.store ?? defaultStore();
        const evidenceSink =
          options.deps?.evidenceSink ??
          (typeof (store as { submit?: unknown }).submit === "function"
            ? (store as MemoryDeliverableStore)
            : new MemoryDeliverableStore());
        const mutationKey = path.join(path.resolve(outputDir), ".finwork-deliverable-mutation");
        const result = await withFileMutationQueue([mutationKey], () => finalizeDeliverables(
          args.files,
          {
            runId,
            outputDir,
            conversationFilesDir: options.conversationFilesDir,
            deliverySpec: contract,
            conversationId: options.conversationId,
            messageId: options.messageId,
          },
          { ...options.deps, store, evidenceSink }
        ));

        // Recalculation happens before the business validator returns.  It can
        // therefore mutate the working workbook even when validation fails.
        // Synchronize on both success and failure, otherwise the repair loop
        // compares recalculated bytes against a stale pre-recalc branch head.
        let finalizedWorkspaceCandidate: { changed: boolean; versionId: string } | null = null;
        if (options.requireWorkspaceChangeReview && options.runId) {
          const workspace = await getFileWorkspaceStore();
          const review = workspaceReviewGate(getDb(), options.runId);
          if (!review.ok) throw new Error(review.message);
          finalizedWorkspaceCandidate = await syncFinalizedWorkspaceCandidate({
            db: getDb(),
            store: workspace,
            runId: options.runId,
            candidatePath: path.resolve(outputDir, review.candidateName),
          });
        }

        if (!result.ok) {
          const detail =
            result.failures
              ?.map(
                (f) =>
                  `${f.name}(${f.contractDeliverableId}): ${f.errors.map((e) =>
                    `${e.code}${e.location ? `@${e.location}` : ""}: ${e.message}`
                  ).join("; ")}`
              )
              .join("\n") ?? result.error;
          return {
            content: [{
              type: "text" as const,
              text: [
                `交付质量门未通过：${detail}`,
                finalizedWorkspaceCandidate
                  ? `重算后候选版本 candidateVersionId=${finalizedWorkspaceCandidate.versionId}；修复后 review 必须把它作为 baseVersionId。`
                  : "",
              ].filter(Boolean).join("\n"),
            }],
            isError: true as const,
            structuredContent: {
              code: result.code,
              error: result.error,
              finalizedWorkspaceCandidate,
              ...(result.failures ? { failures: result.failures } : {}),
            },
          };
        }

        const workspaceOutputs: Array<{
          assetId: string;
          versionId: string;
          logicalPath: string;
          sha256: string;
          taskPath: string;
        }> = [];
        if (options.runId && options.conversationId != null) {
          const workspace = await getFileWorkspaceStore();
          const runPaths = getRunFileWorkspacePaths(options.runId);
          for (const finalized of result.finalized) {
            const workingPath = path.resolve(outputDir, finalized.name);
            const evidence = await recordGeneratedOutputVersion({
              store: workspace,
              db: getDb(),
              runId: options.runId,
              filePath: workingPath,
              logicalPath: finalized.name,
              source: "finalize",
            });
            const taskPath = workspace.materializeVersion(
              evidence.versionId,
              runPaths.outputs,
              finalized.name,
            );
            workspaceOutputs.push({
              assetId: evidence.assetId,
              versionId: evidence.versionId,
              logicalPath: evidence.logicalPath,
              sha256: evidence.sha256,
              taskPath,
            });
          }
        }

        const gateNote =
          result.gate.ok
            ? "合同所需交付物证据已齐。"
            : `证据未齐，缺少: ${result.gate.missing.join(", ")}（Run 完成态由 CompletionGate 决定，本工具不写 completed）。`;

        return {
          content: [
            {
              type: "text" as const,
              text: `已验证并交付: ${result.declaredNames.join("、")}。${gateNote}`,
            },
          ],
          structuredContent: {
            finalized: result.finalized,
            evidences: result.evidences,
            gate: result.gate,
            workspaceOutputs,
            finalizedWorkspaceCandidate,
            // 明确：不包含 runStatus / completed
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `声明最终产物失败:${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true as const,
        };
      }
    }
  );
}
