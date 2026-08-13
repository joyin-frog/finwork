import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { DocumentLocatorSchema } from "@/lib/artifacts/contracts";
import {
  applyOfficeDocumentOperations,
  parseDocumentFile,
} from "@/lib/document-ir";
import type { SdkLike } from "./sdk-types";

const MAX_PAGE_SIZE = 200;
const EDITABLE_EXTENSIONS = new Set([".docx", ".pptx"]);

type DocumentToolOptions = {
  outputDir: string;
  allowedReadRoots?: string[];
};

function resolveAllowedSource(filePath: string, options: DocumentToolOptions): string {
  if (!filePath || !existsSync(filePath)) throw new Error(`document_source_not_found:${filePath}`);
  const resolved = realpathSync(path.resolve(filePath));
  const roots = [options.outputDir, ...(options.allowedReadRoots ?? [])].flatMap((root) => {
    try {
      return [realpathSync(path.resolve(root))];
    } catch {
      return [];
    }
  });
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error("document_source_outside_allowed_roots");
  }
  return resolved;
}

function outputPathFor(sourcePath: string, outputName: string, outputDir: string): string {
  const trimmed = outputName.trim();
  if (!trimmed || path.basename(trimmed) !== trimmed) throw new Error("document_output_name_invalid");
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  if (path.extname(trimmed).toLowerCase() !== sourceExtension) {
    throw new Error(`document_output_extension_mismatch:${sourceExtension}`);
  }
  return path.join(outputDir, trimmed);
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `文档操作失败：${message.slice(0, 1000)}` }],
    isError: true as const,
  };
}

/**
 * Locator discovery is deliberately separate from mutation. The returned
 * source hash is the optimistic-concurrency token required by patch_document.
 */
export function createInspectDocumentStructureTool(
  sdk: SdkLike,
  options: DocumentToolOptions,
) {
  return sdk.tool(
    "inspect_document_structure",
    [
      "检查 DOCX/PPTX/PDF/XLSX 的结构、保真风险与稳定定位器。",
      "修改 DOCX/PPTX 前必须先调用本工具，取得目标节点 locator 和 sourceSha256；不要猜 nodeId。",
      "结果分页返回，blocked=true 表示存在宏、签名、嵌入对象等阻断项，禁止继续修改。",
    ].join("\n"),
    {
      sourcePath: z.string().min(1).describe("待检查文件的绝对路径"),
      offset: z.number().int().nonnegative().default(0).describe("节点分页起点"),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(100).describe("本页节点数，最多 200"),
    },
    async (args: { sourcePath: string; offset?: number; limit?: number }) => {
      try {
        const sourcePath = resolveAllowedSource(String(args.sourcePath ?? "").trim(), options);
        const document = await parseDocumentFile(sourcePath);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 100;
        const nodes = document.nodes.slice(offset, offset + limit).map((node) => ({
          id: node.id,
          kind: node.kind,
          order: node.order,
          text: node.text ?? null,
          locator: node.locator,
          style: node.style ?? null,
        }));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              format: document.format,
              sourceSha256: document.sourceSha256,
              blocked: document.manifest.blocked,
              blockingReasons: document.manifest.blockingReasons,
              preservationFeatures: document.manifest.features,
              page: {
                offset,
                limit,
                returned: nodes.length,
                total: document.nodes.length,
                nextOffset: offset + nodes.length < document.nodes.length ? offset + nodes.length : null,
              },
              nodes,
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

const editableLocator = DocumentLocatorSchema.refine(
  (locator) => locator.kind === "paragraph" || locator.kind === "node",
  "DOCX 需要 paragraph locator，PPTX 需要 node locator",
);

export function createPatchDocumentTool(
  sdk: SdkLike,
  options: DocumentToolOptions,
) {
  return sdk.tool(
    "patch_document",
    [
      "按 inspect_document_structure 返回的稳定定位器，无损修改既有 DOCX 或 PPTX，并另存为新文件。",
      "expectedSourceSha256 必填；源文件在检查后变化会拒绝写入，禁止覆盖原件。",
      "宏、签名、嵌入对象、外部链接等保真风险由内核硬阻断；PDF 只读，XLSX 必须使用 patch_workbook。",
      "当前只支持替换段落或形状文本；不支持的操作会明确失败，不会降级为重建文档。",
      "成功结果包含包级保真检查、结构差异和待做视觉验证标记。",
    ].join("\n"),
    {
      sourcePath: z.string().min(1).describe("原始 DOCX/PPTX 的绝对路径"),
      outputName: z.string().min(1).describe("输出文件名，扩展名必须与源文件一致"),
      expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/i).describe("inspect_document_structure 返回的源哈希"),
      operations: z.array(z.object({
        kind: z.literal("replace_text"),
        locator: editableLocator,
        text: z.string(),
      }).strict()).min(1).max(200).describe("定位替换操作，最多 200 项"),
    },
    async (args: {
      sourcePath: string;
      outputName: string;
      expectedSourceSha256: string;
      operations: Array<{ kind: "replace_text"; locator: z.infer<typeof editableLocator>; text: string }>;
    }) => {
      try {
        const sourcePath = resolveAllowedSource(String(args.sourcePath ?? "").trim(), options);
        const extension = path.extname(sourcePath).toLowerCase();
        if (!EDITABLE_EXTENSIONS.has(extension)) {
          throw new Error(extension === ".xlsx"
            ? "document_format_requires_workbook_patch_engine:xlsx"
            : `document_format_read_only_or_unsupported:${extension || "unknown"}`);
        }
        const targetPath = outputPathFor(sourcePath, String(args.outputName ?? ""), options.outputDir);
        const report = await applyOfficeDocumentOperations({
          sourcePath,
          targetPath,
          expectedSourceSha256: args.expectedSourceSha256.toLowerCase(),
          operations: args.operations,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ targetPath, ...report }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
