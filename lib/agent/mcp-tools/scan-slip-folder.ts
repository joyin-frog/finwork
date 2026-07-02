import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { groupSlipFiles } from "@/lib/domain/slip-grouping";
import type { SdkLike } from "./sdk-types";

// 递归列目录下的文件相对路径(限深度,防超大目录/软链循环)
function walkFiles(root: string, dir = "", acc: string[] = [], depth = 0): string[] {
  if (depth > 6) return acc;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const rel = dir ? path.join(dir, e.name) : e.name;
    if (e.isDirectory()) walkFiles(root, rel, acc, depth + 1);
    else if (e.isFile()) acc.push(rel);
  }
  return acc;
}

/**
 * scan_slip_folder:扫描单据文件夹,自动识别结构分组(一组 = 一张凭证的材料)。
 * 一级子文件夹各成一组,根目录散文件/多页 PDF 各自一组。两种组织与混用都支持。
 */
export function createScanSlipFolderTool(sdk: SdkLike) {
  return sdk.tool(
    "scan_slip_folder",
    "扫描单据文件夹自动分组:一级子文件夹各成一组(一笔),根目录散文件/多页PDF各自一组(一组=一张凭证的全部材料)。处理整个文件夹的单据时先调它拿分组,再对每组的文件逐个 read_document、聚合成一张凭证。返回每组的绝对路径列表。",
    { folderPath: z.string().describe("单据文件夹绝对路径") },
    async (args: { folderPath: string }) => {
      const folderPath = String(args.folderPath ?? "").trim();
      if (!folderPath || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
        return { content: [{ type: "text" as const, text: `文件夹不存在或不是目录:${folderPath}` }], isError: true as const };
      }
      const rel = walkFiles(folderPath);
      const groups = groupSlipFiles(rel).map((g) => ({
        group: g.group,
        files: g.files.map((f) => path.join(folderPath, f)),
      }));
      const text = groups.length
        ? `识别到 ${groups.length} 组(每组=一张凭证):\n` +
          groups.map((g) => `- ${g.group}(${g.files.length} 个文件)`).join("\n")
        : "文件夹里没有可识别的单据文件(支持 PDF/图片/Excel/Word)。";
      return { content: [{ type: "text" as const, text }], structuredContent: { groups, groupCount: groups.length } };
    }
  );
}
