/**
 * CR-Q1 finalize 编排：TaskContract 驱动校验 → 不可变 delivered/ → CompletionEvidence。
 * 绝不写 Run completed（CompletionGate / RunStore 归属 R1）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  completionGateSatisfied,
  validateCompletionEvidence,
  type CompletionEvidence,
  type RequiredDeliverable,
  type TaskContract,
} from "@/lib/agent/run-contract";
import { sha256File } from "./hash";
import { copyToDeliveredImmutable } from "./immutable-copy";
import { mimeFromExtension } from "./mime";
import {
  conversationDirFromOutputDir,
  getDeliveredDir,
  resolveInOutputScope,
} from "./scope";
import {
  createDeliverableRecord,
  type CompletionEvidenceSink,
  type DeliverableStore,
  MemoryDeliverableStore,
} from "./store";
import type { FinalizeContext, FinalizeFile, FinalizeResult, ValidatorIssue } from "./types";
import {
  ensureBuiltinValidatorsRegistered,
  selectValidator,
} from "./validators/registry";

/** 收尾清理用 marker（dotfile）；成功 finalize 后写入声明 basename 列表。 */
export const FINALIZED_MARKER = ".finalized.json";

export type FinalizeDeps = {
  store?: DeliverableStore;
  evidenceSink?: CompletionEvidenceSink;
  /** 正式附件登记（可选；缺省不写 chat_attachments） */
  registerAttachment?: (args: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
  }) => void;
};

export async function finalizeDeliverables(
  files: FinalizeFile[],
  ctx: FinalizeContext,
  deps: FinalizeDeps = {}
): Promise<FinalizeResult> {
  ensureBuiltinValidatorsRegistered();

  const fallback = new MemoryDeliverableStore();
  const store = deps.store ?? fallback;
  const maybeSink = store as unknown as Partial<CompletionEvidenceSink>;
  const sink: CompletionEvidenceSink =
    deps.evidenceSink ??
    (typeof maybeSink.submit === "function" && typeof maybeSink.list === "function"
      ? (store as unknown as CompletionEvidenceSink)
      : fallback);

  if (!ctx.taskContract) {
    return { ok: false, code: "missing_task_contract", error: "TaskContract 未接线，无法 finalize" };
  }
  if (!ctx.runId?.trim()) {
    return { ok: false, code: "missing_run_id", error: "runId 缺失" };
  }

  const normalized = normalizeFinalizeFiles(files);
  if (!normalized.length) {
    return { ok: false, code: "empty_files", error: "未提供有效 FinalizeFile" };
  }

  // 未知 contractDeliverableId 立即失败
  const byId = new Map(ctx.taskContract.requiredDeliverables.map((d) => [d.id, d]));
  for (const f of normalized) {
    if (!byId.has(f.contractDeliverableId)) {
      return {
        ok: false,
        code: "unknown_deliverable_id",
        error: `不存在的 contractDeliverableId: ${f.contractDeliverableId}`,
      };
    }
  }

  const convRoot = ctx.conversationFilesDir ?? conversationDirFromOutputDir(ctx.outputDir);
  const deliveredRoot = getDeliveredDir(convRoot, ctx.runId);
  const failures: NonNullable<Extract<FinalizeResult, { ok: false }>["failures"]> = [];
  const succeeded: Extract<FinalizeResult, { ok: true }>["finalized"] = [];
  const evidences: CompletionEvidence[] = [];

  for (const file of normalized) {
    const req = byId.get(file.contractDeliverableId)!;
    const one = await finalizeOneFile({
      file,
      req,
      ctx,
      store,
      sink,
      deliveredRoot,
      convRoot,
      registerAttachment: deps.registerAttachment,
    });
    if (!one.ok) {
      failures.push(one.failure);
    } else {
      succeeded.push(one.finalized);
      evidences.push(one.evidence);
    }
  }

  if (failures.length) {
    return {
      ok: false,
      code: "validation_failed",
      error: `有 ${failures.length} 个交付物未通过质量门`,
      failures,
    };
  }

  // 合同数量：同一 id 可多次；gate 纯核对
  const prior = sink.list(ctx.runId);
  // sink 在 commitDelivered 时已含本次；若 sink===store 且 commit 已 submit，list 已包含
  // 去重：用 reportId
  const allEvidence = dedupeEvidence([...prior, ...evidences]);
  const gate = completionGateSatisfied(ctx.taskContract, allEvidence);

  // marker：供 cleanupUnfinalizedFiles（只清 generate/ 中间件）
  const declaredNames = succeeded.map((s) => s.name);
  try {
    const markerPath = path.join(ctx.outputDir, FINALIZED_MARKER);
    writeFileSync(markerPath, JSON.stringify(declaredNames), "utf8");
  } catch {
    // marker 失败不回滚已交付（已不可变）；报告仍 ok
  }

  return {
    ok: true,
    finalized: succeeded,
    evidences: allEvidence.filter((e) =>
      succeeded.some((s) => s.deliveredSha256 === e.deliveredSha256)
    ),
    gate,
    declaredNames,
  };
}

async function finalizeOneFile(args: {
  file: FinalizeFile;
  req: RequiredDeliverable;
  ctx: FinalizeContext;
  store: DeliverableStore;
  sink: CompletionEvidenceSink;
  deliveredRoot: string;
  convRoot: string;
  registerAttachment?: FinalizeDeps["registerAttachment"];
}): Promise<
  | { ok: true; finalized: Extract<FinalizeResult, { ok: true }>["finalized"][number]; evidence: CompletionEvidence }
  | { ok: false; failure: NonNullable<Extract<FinalizeResult, { ok: false }>["failures"]>[number] }
> {
  const { file, req, ctx, store, sink, deliveredRoot, convRoot, registerAttachment } = args;
  const scope = resolveInOutputScope(ctx.outputDir, file.name);
  if (!scope.ok) {
    return {
      ok: false,
      failure: {
        name: file.name,
        contractDeliverableId: file.contractDeliverableId,
        errors: [{ code: scope.code, message: scope.message }],
      },
    };
  }

  const workingPath = scope.realPath;
  const workingSha = sha256File(workingPath);
  const st = statSync(workingPath);
  const record = createDeliverableRecord({
    runId: ctx.runId,
    contractDeliverableId: req.id,
    workingPath,
    deliveredPath: null,
    fileName: path.basename(file.name),
    mimeType: req.mime,
    sizeBytes: st.size,
    workingSha256: workingSha,
    deliveredSha256: null,
    validatorId: null,
    qualityProfile: req.qualityProfile,
    validationReportJson: null,
    status: "validating",
  });
  store.upsert(record);

  const validator = selectValidator(req.mime, req.qualityProfile);
  const sheetReq = ctx.taskContract.spreadsheetRequirement;
  const report = await validator.validate({
    filePath: workingPath,
    fileName: record.fileName,
    expectedMime: req.mime,
    qualityProfile: req.qualityProfile,
    expectedSha256: workingSha,
    needsRecalc: sheetReq?.needsRecalc,
    recalcPolicy:
      sheetReq?.needsRecalc === true || req.qualityProfile === "financial_consolidation"
        ? "required"
        : "best_effort",
    needsRender: sheetReq?.needsRender,
    requireFormulaCache: sheetReq?.needsRecalc === true,
  });

  record.validatorId = report.validatorId;
  record.validationReportJson = JSON.stringify(report);
  record.workingSha256 = report.fileSha256;

  if (report.status !== "passed") {
    record.status = "validation_failed";
    record.validatedAt = new Date().toISOString();
    store.upsert(record);
    return {
      ok: false,
      failure: {
        name: record.fileName,
        contractDeliverableId: req.id,
        errors: report.errors,
        workingPath,
      },
    };
  }

  // 绑定 hash：校验后若工作文件被改，immutable copy 会失败
  const copy = copyToDeliveredImmutable({
    workingPath,
    deliveredDir: deliveredRoot,
    fileName: record.fileName,
    expectedSha256: report.fileSha256,
  });
  if (!copy.ok) {
    record.status = "validation_failed";
    record.validationReportJson = JSON.stringify({
      ...report,
      status: "failed",
      errors: [...report.errors, { code: copy.code, message: copy.message }],
    });
    store.upsert(record);
    return {
      ok: false,
      failure: {
        name: record.fileName,
        contractDeliverableId: req.id,
        errors: [{ code: copy.code, message: copy.message }],
        workingPath,
      },
    };
  }

  const validatedAt = new Date().toISOString();
  record.status = "delivered";
  record.deliveredPath = copy.deliveredPath;
  record.deliveredSha256 = copy.deliveredSha256;
  record.mimeType = copy.mime;
  record.sizeBytes = copy.sizeBytes;
  record.validatedAt = validatedAt;
  record.deliveredAt = validatedAt;

  const evidence: CompletionEvidence = {
    runId: ctx.runId,
    contractDeliverableId: req.id,
    deliveredPath: copy.deliveredPath,
    deliveredSha256: copy.deliveredSha256,
    mime: copy.mime || req.mime || mimeFromExtension(record.fileName),
    validatorId: report.validatorId,
    qualityProfile: req.qualityProfile,
    validationStatus: "passed",
    validatedAt,
    reportId: randomUUID(),
  };
  const evCheck = validateCompletionEvidence(evidence);
  if (!evCheck.ok) {
    record.status = "validation_failed";
    store.upsert(record);
    // 清理半交付副本
    try {
      const { rmSync } = await import("node:fs");
      rmSync(copy.deliveredPath, { force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      failure: {
        name: record.fileName,
        contractDeliverableId: req.id,
        errors: evCheck.errors.map((m) => ({ code: "evidence_invalid", message: m })),
        workingPath,
      },
    };
  }

  try {
    // 同一事务：registry + evidence（不写 Run completed）
    store.commitDelivered({ record, evidence: evCheck.evidence });
    // 若 sink 独立于 store，再 submit 一次
    if (sink !== (store as unknown as CompletionEvidenceSink)) {
      sink.submit(evCheck.evidence);
    }
  } catch (e) {
    // 事务失败：删掉 delivered 副本，避免半 delivered
    try {
      const { rmSync } = await import("node:fs");
      if (existsSync(copy.deliveredPath)) rmSync(copy.deliveredPath, { force: true });
    } catch {
      /* ignore */
    }
    record.status = "validation_failed";
    store.upsert(record);
    return {
      ok: false,
      failure: {
        name: record.fileName,
        contractDeliverableId: req.id,
        errors: [
          {
            code: "commit_failed",
            message: e instanceof Error ? e.message : String(e),
          },
        ],
        workingPath,
      },
    };
  }

  if (registerAttachment) {
    const storagePath = path.relative(convRoot, copy.deliveredPath).split(path.sep).join("/");
    registerAttachment({
      fileName: record.fileName,
      mimeType: evidence.mime,
      sizeBytes: copy.sizeBytes,
      storagePath,
    });
  }

  return {
    ok: true,
    finalized: {
      name: record.fileName,
      contractDeliverableId: req.id,
      deliveredPath: copy.deliveredPath,
      deliveredSha256: copy.deliveredSha256,
      status: "delivered",
    },
    evidence: evCheck.evidence,
  };
}

function normalizeFinalizeFiles(files: FinalizeFile[]): FinalizeFile[] {
  const out: FinalizeFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const name = path.basename(String(f.name ?? "").trim());
    const id = String(f.contractDeliverableId ?? "").trim();
    if (!name || !id) continue;
    const key = `${id}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, contractDeliverableId: id });
  }
  return out;
}

function dedupeEvidence(list: CompletionEvidence[]): CompletionEvidence[] {
  const byReport = new Map<string, CompletionEvidence>();
  for (const e of list) byReport.set(e.reportId, e);
  return [...byReport.values()];
}

/** 测试/诊断：合同是否把某 id 标为 required */
export function requiredDeliverable(
  contract: TaskContract,
  id: string
): RequiredDeliverable | undefined {
  return contract.requiredDeliverables.find((d) => d.id === id);
}

export type { ValidatorIssue };
