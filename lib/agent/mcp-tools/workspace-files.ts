import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { getDb } from "@/lib/db/sqlite";
import { getFileWorkspaceStore } from "@/lib/file-workspace";
import { runDocumentWorker } from "@/lib/resource/document-worker-pool";
import { redact } from "@/lib/safety/pii";
import { spreadsheetPatchWorkbook, type WorkbookEdit } from "@/lib/runtime/spreadsheet-runtime";
import type { SdkLike } from "./sdk-types";
import { createBeginWorkspaceChangeTool, createReviewWorkspaceChangeTool } from "./review-workspace-change";

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
        const [prepared] = store.prepareRunWorkspace(runId, [{ assetId: args.assetId, role: "input" }]);
        options.onPreparedInput?.(prepared.path);
        const extension = path.extname(prepared.name).toLowerCase();
        let text: string;
        if ([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".log"].includes(extension)) {
          text = readFileSync(prepared.path, "utf8").slice(0, 200_000);
        } else if ([".pdf", ".xlsx", ".xls", ".docx", ".pptx"].includes(extension)) {
          text = await runDocumentWorker("extract-text", prepared.path);
        } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
          text = await runDocumentWorker("ocr-image", prepared.path);
        } else {
          return error(`暂不支持解析 ${extension || "该类型"}，但文件已安全快照`);
        }
        return {
          content: [{ type: "text" as const, text: [
            `任务内只读路径：${prepared.path}`,
            redact(text).slice(0, 200_000) || "(未提取到文本)",
          ].join("\n\n") }],
          structuredContent: {
            assetId: prepared.assetId,
            versionId: prepared.versionId,
            name: prepared.name,
            taskPath: prepared.path,
          },
        };
      },
    ),
    sdk.tool(
      "patch_workspace_workbook",
      "按 assetId 无损修改本回合授权的 Excel 工作簿并另存到任务输出区；无需也不得提供主机路径。只改指定单元格，其余公式、样式和缓存原样保留。",
      {
        assetId: z.string().uuid().describe("受管工作簿 assetId"),
        outputName: z.string().regex(/\.xlsx$/i).describe("输出文件名"),
        edits: z.array(z.object({
          sheet: z.string().min(1),
          cell: z.string().regex(/^[A-Za-z]{1,3}\d{1,7}$/),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
          formula: z.string().optional(),
          clear: z.boolean().optional(),
          createSheet: z.boolean().optional(),
        })).min(1).max(2_000),
      },
      async (args: { assetId: string; outputName: string; edits: WorkbookEdit[] }) => {
        if (!options.outputDir) return error("任务输出目录不可用");
        if (!isAssetAllowed(args.assetId)) {
          return error("该工作簿不在本回合授权范围内");
        }
        const store = await getFileWorkspaceStore();
        const [source] = store.prepareRunWorkspace(options.runId ?? "broker", [{ assetId: args.assetId, role: "input" }]);
        const outputName = path.basename(args.outputName);
        const outputPath = path.join(options.outputDir, outputName);
        const result = await spreadsheetPatchWorkbook(source.path, outputPath, args.edits);
        if (!result.ok || !result.data) return error(`修改失败（${result.errorCode ?? "unknown"}）：${result.detail ?? ""}`);
        const candidate = store.ingestManagedBuffer({
          name: outputName,
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          content: readFileSync(outputPath),
          sourceKind: "generated",
          batchId: options.runId,
        });
        allowedAssets.add(candidate.assetId);
        return {
          content: [{ type: "text" as const, text: `已生成 ${outputName}；应用 ${result.data.applied.length} 处改动。请继续校验并正式交付。` }],
          structuredContent: { assetId: candidate.assetId, versionId: candidate.versionId, outputName, result: result.data },
        };
      },
    ),
  ];
  if (options.outputDir) {
    const reviewOptions = {
      runId: options.runId ?? "broker",
      outputDir: options.outputDir,
      isAssetAllowed,
    };
    tools.push(createBeginWorkspaceChangeTool(sdk, reviewOptions));
    tools.push(createReviewWorkspaceChangeTool(sdk, reviewOptions));
  }
  return tools;
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}
