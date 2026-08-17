import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getDb } from "@/lib/db/sqlite";
import {
  createFileChangeSet,
  evaluateWorkspaceChangePlan,
  getFileWorkspaceStore,
  recordScriptRevision,
  semanticDiffFiles,
  type WorkspaceChangeTarget,
} from "@/lib/file-workspace";
import type { SdkLike } from "./sdk-types";

type ReviewOptions = {
  runId: string;
  outputDir: string;
  isAssetAllowed: (assetId: string) => boolean;
};

type FrozenChangePlan = {
  planId: string;
  runId: string;
  assetId: string;
  baseVersionId: string;
  targets: WorkspaceChangeTarget[];
  declaredAt: string;
};

const targetSchema = z.object({
  description: z.string().min(1).max(500),
  sheet: z.string().min(1).max(100).optional(),
  cell: z.string().regex(/^[A-Za-z]{1,3}\d{1,7}$/).optional(),
  expectedValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  expectedFormula: z.string().max(8_000).optional(),
  mustChange: z.boolean().optional(),
});

export function createBeginWorkspaceChangeTool(sdk: SdkLike, options: ReviewOptions) {
  return sdk.tool(
    "begin_workspace_change",
    "读取并理解受管文件后、开始修改前调用：冻结本轮要改和要保持的格子级目标。计划只能由后续复核引用，不能在看到结果后删掉未完成目标。",
    {
      assetId: z.string().uuid(),
      targets: z.array(targetSchema).min(1).max(500),
    },
    async (args: { assetId: string; targets: WorkspaceChangeTarget[] }) => {
      try {
        if (!options.isAssetAllowed(args.assetId)) return toolError("该文件不在本回合授权范围内");
        const db = getDb();
        const existing = db.prepare(`
          SELECT asset_id FROM workspace_assets
          WHERE batch_id=? AND media_type='application/vnd.finwork.change-plan+json'
            AND lifecycle_status='active'
          ORDER BY created_at DESC LIMIT 1
        `).get(`${options.runId}:${args.assetId}`) as { asset_id: string } | undefined;
        if (existing) return toolError(`本轮修改计划已经冻结：planId=${existing.asset_id}`);
        const store = await getFileWorkspaceStore();
        const base = store.getAsset(args.assetId);
        const declaredAt = new Date().toISOString();
        const payload = {
          runId: options.runId,
          assetId: args.assetId,
          baseVersionId: base.versionId,
          targets: args.targets,
          declaredAt,
        };
        const plan = store.ingestManagedBuffer({
          name: `change-plan-${args.assetId}.json`,
          mediaType: "application/vnd.finwork.change-plan+json",
          content: Buffer.from(JSON.stringify(payload)),
          sourceKind: "generated",
          batchId: `${options.runId}:${args.assetId}`,
        });
        store.linkTaskFile(options.runId, plan.assetId, plan.versionId, "evidence");
        return {
          content: [{ type: "text" as const, text: `已冻结 ${args.targets.length} 项修改计划，planId=${plan.assetId}。现在可以编写或调整脚本；后续 review_workspace_change 必须引用此 planId。` }],
          structuredContent: { kind: "workspace_change_plan", planId: plan.assetId, assetId: args.assetId, baseVersionId: base.versionId, targets: args.targets, declaredAt },
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

/**
 * 动态脚本不直接拥有用户目录权限。Agent 可以在 outputDir 中反复 write/edit，
 * 并通过 run_task_python 执行，
 * 每轮用本工具把脚本、输入版本、候选文件、语义 diff 和计划完成度冻结成证据。
 */
export function createReviewWorkspaceChangeTool(sdk: SdkLike, options: ReviewOptions) {
  return sdk.tool(
    "review_workspace_change",
    [
      "复核动态脚本或受控工具生成的文件，并把本轮脚本版本、输入版本、候选版本、语义差异和未完成目标写入变更链。",
      "candidatePath 和 scriptPath 必须是本回合输出目录内的相对路径。",
      "工作过程中可多次调用 final=false，根据 pendingTargets 调整脚本；最终只有所有可验证目标完成后才用 final=true。",
      "Excel 必须尽量用 sheet/cell/expectedValue/expectedFormula 声明目标；只有自然语言描述的目标不会被系统自行判为完成。",
    ].join("\n"),
    {
      assetId: z.string().uuid().describe("本回合授权的原始文件 assetId"),
      planId: z.string().uuid().optional().describe("begin_workspace_change 冻结的计划 ID；最终复核必填"),
      candidatePath: z.string().min(1).describe("输出目录内的候选文件相对路径"),
      scriptPath: z.string().min(1).optional().describe("本轮实际执行脚本在输出目录内的相对路径"),
      changePlan: z.array(targetSchema).max(500).default([]),
      final: z.boolean().optional().describe("是否把本轮候选作为最终结果提交后端完成门"),
      readyForUser: z.boolean().optional().describe("兼容旧调用；等价于 final，不再触发用户审批"),
      validationNotes: z.array(z.string().min(1).max(1_000)).max(100).default([]),
    },
    async (args: {
      assetId: string;
      planId?: string;
      candidatePath: string;
      scriptPath?: string;
      changePlan: WorkspaceChangeTarget[];
      final?: boolean;
      readyForUser?: boolean;
      validationNotes: string[];
    }) => {
      let reviewRoot = "";
      try {
        if (!options.isAssetAllowed(args.assetId)) return toolError("该文件不在本回合授权范围内");
        const candidatePath = resolveOutputPath(options.outputDir, args.candidatePath);
        assertRegularFile(candidatePath, "候选文件");
        const store = await getFileWorkspaceStore();
        const base = store.getAsset(args.assetId);
        const frozenPlan = args.planId ? loadFrozenPlan(store, getDb(), args.planId, options.runId, args.assetId) : null;
        const targets = frozenPlan?.targets ?? args.changePlan;
        const requestedFinal = args.final ?? args.readyForUser ?? false;
        reviewRoot = path.join(options.outputDir, ".finwork-review", randomUUID());
        fs.mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
        const baselinePath = store.materializeVersion(base.versionId, reviewRoot, base.name);
        const diff = await semanticDiffFiles(baselinePath, candidatePath);
        const plan = evaluateWorkspaceChangePlan(diff, targets);
        if (requestedFinal && !frozenPlan) {
          plan.complete = false;
          plan.pending.push({ description: "引用修改前冻结的 planId", reason: "最终复核不能在看到结果后临时声明计划" });
        }
        if (requestedFinal && diff.kind === "xlsx" && targets.length === 0) {
          plan.complete = false;
          plan.pending.push({ description: "声明最终格子级 changePlan", reason: "Excel 最终复核不能使用空计划" });
        }
        if (requestedFinal && frozenPlan) {
          const planTime = Date.parse(frozenPlan.declaredAt);
          const candidateTime = fs.statSync(candidatePath).mtimeMs;
          const scriptTime = args.scriptPath ? fs.statSync(resolveOutputPath(options.outputDir, args.scriptPath)).mtimeMs : candidateTime;
          if (Number.isFinite(planTime) && Math.max(candidateTime, scriptTime) < planTime) {
            plan.complete = false;
            plan.pending.push({ description: "计划冻结后重新生成候选", reason: "候选文件和脚本都早于修改计划" });
          }
        }
        const script = args.scriptPath
          ? await recordScriptRevision({
              store,
              db: getDb(),
              runId: options.runId,
              scriptPath: resolveOutputPath(options.outputDir, args.scriptPath),
              logicalPath: args.scriptPath,
            })
          : null;
        const complete = requestedFinal && plan.complete;
        const db = getDb();
        db.prepare(`
          UPDATE file_changesets SET status='rejected',resolved_at=?
          WHERE run_id=? AND asset_id=? AND status='pending'
        `).run(new Date().toISOString(), options.runId, args.assetId);
        const iteration = Number((db.prepare(
          "SELECT COUNT(*) AS n FROM file_changesets WHERE run_id=? AND asset_id=?",
        ).get(options.runId, args.assetId) as { n: number }).n) + 1;
        const validation = {
          passed: plan.complete,
          complete,
          requestedFinal,
          // 旧字段只留给历史数据兼容。diff 是 Agent 的内部证据，不再制造用户审批门。
          readyForUser: false,
          iteration,
          candidateName: path.basename(candidatePath),
          planId: frozenPlan?.planId ?? null,
          changePlan: targets,
          plan,
          validationNotes: args.validationNotes,
          script,
        };
        const change = await createFileChangeSet({
          db,
          store,
          runId: options.runId,
          assetId: args.assetId,
          candidatePath,
          validation,
          diff,
        });
        const pendingText = plan.pending.slice(0, 20).map((item) =>
          `- ${item.address ? `${item.address}：` : ""}${item.description}（${item.reason}）`,
        ).join("\n");
        const text = [
          `第 ${iteration} 轮文件复核：${diff.summary}。`,
          `计划完成 ${plan.completed.length}/${targets.length} 项。`,
          plan.pending.length ? `仍未完成：\n${pendingText}` : "所有已声明目标均已确定性通过。",
          complete ? "已通过后端完成门，可以继续正式交付。" : "请根据差异与未完成目标继续调整脚本或文件。",
        ].join("\n");
        const structuredContent = {
          kind: "workspace_change_review",
          changesetId: change.changesetId,
          runId: options.runId,
          assetId: args.assetId,
          baseVersionId: base.versionId,
          candidateVersionId: change.candidateVersionId,
          candidateName: path.basename(candidatePath),
          planId: frozenPlan?.planId ?? null,
          iteration,
          complete,
          readyForUser: false,
          diff: change.diff,
          plan,
          script,
        };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent,
          ...(requestedFinal && !complete ? { isError: true as const } : {}),
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      } finally {
        if (reviewRoot) {
          try { fs.rmSync(reviewRoot, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
    },
  );
}

function loadFrozenPlan(
  store: Awaited<ReturnType<typeof getFileWorkspaceStore>>,
  db: ReturnType<typeof getDb>,
  planId: string,
  runId: string,
  assetId: string,
): FrozenChangePlan {
  const row = db.prepare(`
    SELECT current_version_id,batch_id,media_type FROM workspace_assets
    WHERE asset_id=? AND lifecycle_status='active'
  `).get(planId) as { current_version_id: string; batch_id: string | null; media_type: string } | undefined;
  if (!row || row.media_type !== "application/vnd.finwork.change-plan+json" || row.batch_id !== `${runId}:${assetId}`) {
    throw new Error("修改计划不存在或不属于本轮文件");
  }
  const payload = JSON.parse(store.readVersion(row.current_version_id).toString("utf8")) as Omit<FrozenChangePlan, "planId">;
  if (payload.runId !== runId || payload.assetId !== assetId || !Array.isArray(payload.targets)) throw new Error("修改计划内容无效");
  return { planId, ...payload };
}

function resolveOutputPath(outputDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("只接受输出目录内的相对路径");
  const root = path.resolve(outputDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("路径越过本回合输出目录");
  return resolved;
}

function assertRegularFile(filePath: string, label: string): void {
  const link = fs.lstatSync(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${label}不是普通文件`);
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}
