import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getDb } from "@/lib/db/sqlite";
import {
  createFileChangeSet,
  evaluateWorkspaceChangePlan,
  getFileWorkspaceStore,
  resolveWorkspaceBranchHead,
  semanticDiffFiles,
  type WorkspaceChangeTarget,
} from "@/lib/file-workspace";
import { runDocumentWorker } from "@/lib/resource/document-worker-pool";
import { redact } from "@/lib/safety/pii";
import { spreadsheetPatchWorkbook, type WorkbookEdit } from "@/lib/runtime/spreadsheet-runtime";
import { getRunFileWorkspacePaths } from "@/lib/runtime/paths";
import type { SdkLike } from "./sdk-types";

const workspaceWorkbookEdit = z.object({
  sheet: z.string().min(1),
  cell: z.string().regex(/^[A-Za-z]{1,3}\d{1,7}$/),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  formula: z.string().optional(),
  clear: z.boolean().optional(),
  createSheet: z.boolean().optional(),
});
const workspaceWorkbookEdits = z.array(workspaceWorkbookEdit).min(1).max(2_000);

export function createWorkspaceFileTools(
  sdk: SdkLike,
  options: {
    rootIds?: string[];
    assetIds?: string[];
    runId?: string;
    outputDir?: string;
    onPreparedInput?: (preparedPath: string) => void;
  } = {},
) {
  const allowed = new Set(options.rootIds ?? []);
  const allowedAssets = new Set(options.assetIds ?? []);
  const readCache = new Map<string, Promise<{
    assetId: string;
    versionId: string;
    name: string;
    path: string;
    text: string;
  }>>();
  const isAssetAllowed = (assetId: string) => {
    if (allowedAssets.has(assetId)) return true;
    const row = getDb().prepare("SELECT workspace_root_id FROM workspace_assets WHERE asset_id=? AND lifecycle_status='active'")
      .get(assetId) as { workspace_root_id: string | null } | undefined;
    return Boolean(row?.workspace_root_id && allowed.has(row.workspace_root_id));
  };
  const tools = [
    sdk.tool(
      "list_workspace_files",
      "列出或搜索用户本回合明确授权文件夹中的文件。返回 assetId，不返回或暴露主机绝对路径。文件很多时先用 query 缩小范围。",
      {
        query: z.string().optional().describe("文件名或相对路径关键词，可省略"),
        limit: z.number().int().min(1).max(500).optional().describe("最多返回数量，默认 100"),
      },
      async (args: { query?: string; limit?: number }) => {
        if (!allowed.size && !allowedAssets.size) return error("本回合没有授权文件");
        const store = await getFileWorkspaceStore();
        const query = args.query?.trim().toLowerCase();
        const managed = [...allowedAssets].flatMap((assetId) => {
          try { return [store.getAsset(assetId)]; } catch { return []; }
        }).filter((file) => !query || file.name.toLowerCase().includes(query));
        const files = [
          ...managed,
          ...[...allowed].flatMap((rootId) => store.listAssets({ rootId, q: args.query, limit: args.limit ?? 100 })),
        ];
        const unique = [...new Map(files.map((file) => [file.assetId, file])).values()].slice(0, args.limit ?? 100);
        return {
          content: [{ type: "text" as const, text: unique.length ? `找到 ${unique.length} 个文件。请用 read_workspace_file(assetId) 读取需要的文件。` : "没有匹配文件。" }],
          structuredContent: { files: unique.map((file) => ({ assetId: file.assetId, name: file.name, mediaType: file.mediaType, sizeBytes: file.sizeBytes })) },
        };
      },
    ),
    sdk.tool(
      "read_workspace_file",
      "按 assetId 读取已授权文件。系统会创建不可变快照并在隔离任务工作区解析，模型无需也不能使用真实主机路径。",
      { assetId: z.string().uuid().describe("list_workspace_files 返回的 assetId") },
      async (args: { assetId: string }) => {
        if (!isAssetAllowed(args.assetId)) {
          return error("该文件不在本回合授权范围内");
        }
        const store = await getFileWorkspaceStore();
        const runId = options.runId ?? "broker";
        const headVersionId = resolveWorkspaceBranchHead({
          db: getDb(),
          store,
          runId,
          assetId: args.assetId,
        });
        const cacheKey = `${args.assetId}:${headVersionId}`;
        const cacheHit = readCache.has(cacheKey);
        let prepared = readCache.get(cacheKey);
        if (!prepared) {
          prepared = (async () => {
            let head = store.getVersion(headVersionId);
            let preparedPath: string;
            if (head.blobId) {
              preparedPath = store.materializeVersion(
                  head.versionId,
                  getRunFileWorkspacePaths(runId).inputs,
                  head.name,
                );
            } else {
              const snapshot = store.prepareRunWorkspace(runId, [{ assetId: args.assetId, role: "input" }])[0];
              head = snapshot;
              preparedPath = snapshot.path;
            }
            store.linkTaskFile(runId, head.assetId, head.versionId, "input");
            options.onPreparedInput?.(preparedPath);
            const extension = path.extname(head.name).toLowerCase();
            let text: string;
            if ([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".log"].includes(extension)) {
              text = readFileSync(preparedPath, "utf8").slice(0, 200_000);
            } else if ([".pdf", ".xlsx", ".xls", ".docx", ".pptx"].includes(extension)) {
              text = await runDocumentWorker("extract-text", preparedPath);
            } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
              text = await runDocumentWorker("ocr-image", preparedPath);
            } else {
              throw new Error(`暂不支持解析 ${extension || "该类型"}，但文件已安全快照`);
            }
            return {
              assetId: head.assetId,
              versionId: head.versionId,
              name: head.name,
              path: preparedPath,
              text,
            };
          })();
          readCache.set(cacheKey, prepared);
        }
        let resolved: Awaited<typeof prepared>;
        try {
          resolved = await prepared;
        } catch (caught) {
          readCache.delete(cacheKey);
          return error(caught instanceof Error ? caught.message : String(caught));
        }
        return {
          content: [{ type: "text" as const, text: [
            `任务内只读路径：${resolved.path}`,
            redact(resolved.text).slice(0, 200_000) || "(未提取到文本)",
          ].join("\n\n") }],
          structuredContent: {
            assetId: resolved.assetId,
            versionId: resolved.versionId,
            name: resolved.name,
            taskPath: resolved.path,
            cacheHit,
          },
        };
      },
    ),
    sdk.tool(
      "patch_workspace_workbook",
      [
        "无损修改受管 Excel 工作簿的当前候选。系统自动选择唯一分支头、记录语义 diff 和内部变更计划；不要管理版本号，也不要另行调用 begin/review 工具。",
        "复杂模型优先让 run_task_python 把编辑清单写成输出目录内的 JSON 数组，再传 editsFilePath；不要把几百项编辑重新抄进工具参数。",
      ].join("\n"),
      {
        assetId: z.string().uuid().describe("受管工作簿 assetId"),
        outputName: z.string().regex(/\.xlsx$/i).optional().describe("可选交付文件名；省略时沿用原工作簿名"),
        edits: workspaceWorkbookEdits.optional().describe("少量内联编辑；与 editsFilePath 至少提供一个"),
        editsFilePath: z.string().optional().describe("run_task_python 在本回合输出目录写出的 JSON 编辑数组路径"),
      },
      async (args: { assetId: string; outputName?: string; edits?: WorkbookEdit[]; editsFilePath?: string }) => {
        if (!options.outputDir) return error("任务输出目录不可用");
        if (!isAssetAllowed(args.assetId)) {
          return error("该工作簿不在本回合授权范围内");
        }
        const edits = [...(args.edits ?? [])];
        if (args.editsFilePath?.trim()) {
          const outputRoot = path.resolve(options.outputDir);
          const requested = path.resolve(outputRoot, args.editsFilePath.trim());
          if (requested !== outputRoot && !requested.startsWith(outputRoot + path.sep)) {
            return error("editsFilePath 必须位于本回合输出目录内");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(readFileSync(requested, "utf8"));
          } catch (caught) {
            return error(`无法读取编辑清单：${caught instanceof Error ? caught.message : String(caught)}`);
          }
          const validated = workspaceWorkbookEdits.safeParse(parsed);
          if (!validated.success) return error(`编辑清单格式错误：${validated.error.issues[0]?.message ?? "invalid edits"}`);
          edits.push(...validated.data);
        }
        if (edits.length === 0) return error("edits 与 editsFilePath 至少提供一个");
        if (edits.length > 2_000) return error("单次最多 2000 处编辑");
        const store = await getFileWorkspaceStore();
        const runId = options.runId ?? "broker";
        const sourceVersionId = resolveWorkspaceBranchHead({
          db: getDb(),
          store,
          runId,
          assetId: args.assetId,
        });
        const source = store.getVersion(sourceVersionId);
        const sourcePath = store.materializeVersion(
          sourceVersionId,
          getRunFileWorkspacePaths(runId).work,
          source.name,
        );
        store.linkTaskFile(runId, source.assetId, sourceVersionId, "baseline");
        const outputName = path.basename(args.outputName?.trim() || source.name);
        if (!/\.xlsx$/i.test(outputName)) return error("输出文件名必须是 .xlsx 文件");
        const outputPath = path.join(options.outputDir, outputName);
        const result = await spreadsheetPatchWorkbook(sourcePath, outputPath, edits);
        if (!result.ok || !result.data) return error(`修改失败（${result.errorCode ?? "unknown"}）：${result.detail ?? ""}`);
        const diff = await semanticDiffFiles(sourcePath, outputPath);
        if (!diff.changed) {
          return error("no_effect: 编辑清单没有产生语义变化；未创建空候选版本");
        }
        const targets = workbookTargetsFromEdits(edits);
        const plan = evaluateWorkspaceChangePlan(diff, targets);
        const planId = randomUUID();
        const db = getDb();
        const iteration = Number((db.prepare(
          "SELECT COUNT(*) AS n FROM file_changesets WHERE run_id=? AND asset_id=?",
        ).get(runId, args.assetId) as { n: number }).n) + 1;
        const validation = {
          kind: "harness_managed_workbook_edit",
          complete: plan.complete,
          requestedFinal: plan.complete,
          readyForUser: false,
          iteration,
          candidateName: outputName,
          planId,
          changePlan: targets,
          plan,
        };
        const change = await createFileChangeSet({
          db,
          store,
          runId,
          assetId: args.assetId,
          candidatePath: outputPath,
          validation,
          diff,
          baseVersionId: sourceVersionId,
        });
        db.prepare(`
          UPDATE file_changesets SET status='rejected',resolved_at=?
          WHERE run_id=? AND asset_id=? AND status='pending' AND changeset_id<>?
        `).run(new Date().toISOString(), runId, args.assetId, change.changesetId);
        const pending = plan.pending.slice(0, 20).map((item) =>
          `${item.address ?? item.description}（${item.reason}）`,
        );
        return {
          content: [{
            type: "text" as const,
            text: [
              `已更新当前工作簿并应用 ${result.data.applied.length} 处改动；${diff.summary}。`,
              plan.complete
                ? "内部变更计划与版本证据已自动完成，可以继续正式交付验证。"
                : `仍有 ${plan.pending.length} 项未达到预期：${pending.join("；")}`,
            ].join("\n"),
          }],
          structuredContent: {
            kind: "workspace_workbook_head",
            assetId: args.assetId,
            versionId: change.candidateVersionId,
            baseVersionId: sourceVersionId,
            candidateVersionId: change.candidateVersionId,
            changesetId: change.changesetId,
            outputName,
            complete: plan.complete,
            plan,
            diff,
            result: result.data,
          },
          ...(plan.complete ? {} : { isError: true as const }),
        };
      },
    ),
  ];
  return tools;
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function workbookTargetsFromEdits(edits: WorkbookEdit[]): WorkspaceChangeTarget[] {
  const byAddress = new Map<string, WorkspaceChangeTarget>();
  for (const edit of edits) {
    const cell = edit.cell.toUpperCase();
    const target: WorkspaceChangeTarget = {
      description: `应用工作簿编辑 ${edit.sheet}!${cell}`,
      sheet: edit.sheet,
      cell,
      mustChange: true,
      ...(edit.formula != null ? { expectedFormula: edit.formula } : {}),
      ...(edit.clear === true
        ? { expectedValue: null }
        : edit.value !== undefined
          ? { expectedValue: edit.value }
          : {}),
    };
    byAddress.set(`${edit.sheet}!${cell}`, target);
  }
  return [...byAddress.values()];
}
