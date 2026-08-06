import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { z } from "zod/v4";
import { spreadsheetPatchWorkbook, type WorkbookEdit } from "@/lib/runtime/spreadsheet-runtime";
import type { SdkLike } from "./sdk-types";

// 合并工作底稿的 TB 表动辄 300 行 × 18 列,上限太低会把模型逼回写脚本
// (HISTORY-002 实测:模型宁可写 27 个 Python 脚本也没用工具)。
// 仍然设上限:单次调用的 payload 受模型输出 token 约束,超大批量应分次链式写入。
const MAX_EDITS = 2000;

const edit = z.object({
  sheet: z.string().min(1).describe("工作表名，必须与原表完全一致"),
  cell: z.string().regex(/^[A-Za-z]{1,3}\d{1,7}$/).describe("单元格地址，如 P7"),
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
    .describe("单元格的值；与 formula 同时给出时作为该公式的缓存结果"),
  formula: z.string().optional().describe("公式文本，含或不含前导 = 均可"),
  clear: z.boolean().optional().describe("true 表示清空该单元格"),
  createSheet: z.boolean().optional()
    .describe("true 表示 sheet 不存在时新建；不写此项且表名不存在会报 sheet_not_found，防止表名打错被静默新建成空表"),
});

/**
 * 无损编辑既有工作簿。
 *
 * 存在的理由:openpyxl 的 load→save 会清空整册公式缓存值(实测真实工作簿
 * 1164 → 0)。一旦丢失,含外部链接的公式在本机再也算不回来——那些外部文件
 * 根本不在这台机器上。所以「改用户已有的表」必须走这条路,不能用脚本重写。
 */
export function createPatchWorkbookTool(
  sdk: SdkLike,
  options: { outputDir: string; allowedReadRoots?: string[] } = { outputDir: process.cwd() },
) {
  return sdk.tool(
    "patch_workbook",
    [
      "在既有 Excel 工作簿上就地修改指定单元格，并把结果另存为新文件。",
      "**修改用户上传的表格时必须用本工具**：用 openpyxl/pandas 打开再保存会清空整册公式的缓存值，含外部链接的数据将永久丢失且无法重算。",
      "只写你点名的单元格，其余内容、样式、公式与缓存值原样保留。",
      "**附件里提供了模板或工作底稿时，填它、不要重建同名表**：模板自带的公式就是计算逻辑，重建等于丢掉它们。",
      `单次最多 ${MAX_EDITS} 处改动；要写的格子更多时分多次调用——把上一次的输出文件路径当作下一次的 sourcePath 即可，改动会累积。`,
      "只写了公式没给结果的单元格，会自动用公式引擎补算缓存值；算不出的会明确列出，那是预期行为，不要改用脚本重写。",
      "返回改动清单与「下游待校验公式」——引用了被改单元格的公式，其缓存值已过期，需要复核。",
      "新建空白表格不需要本工具；本工具用于修改已有文件。",
    ].join("\n"),
    {
      sourcePath: z.string().describe("待修改的原始工作簿绝对路径（不会被改动）"),
      outputName: z.string().describe("输出文件名，落在本回合输出目录下"),
      edits: z.array(edit).min(1).max(MAX_EDITS).describe("要写入的单元格清单"),
    },
    async (args: { sourcePath: string; outputName: string; edits: WorkbookEdit[] }) => {
      const sourcePath = String(args.sourcePath ?? "").trim();
      if (!sourcePath || !existsSync(sourcePath)) {
        return {
          content: [{ type: "text" as const, text: `源文件不存在：${sourcePath}` }],
          isError: true as const,
        };
      }
      // 读路径白名单:与 read_document 同一套边界,避免借 symlink 读任意文件。
      const resolvedSource = realpathSync(path.resolve(sourcePath));
      const roots = [options.outputDir, ...(options.allowedReadRoots ?? [])].flatMap((root) => {
        try {
          return [realpathSync(path.resolve(root))];
        } catch {
          return [];
        }
      });
      if (!roots.some((root) => resolvedSource === root || resolvedSource.startsWith(root + path.sep))) {
        return {
          content: [{ type: "text" as const, text: "读取失败：源文件不在允许的目录内" }],
          isError: true as const,
        };
      }
      // 写只允许落在本回合输出目录,文件名不得越级。
      const outputName = path.basename(String(args.outputName ?? "").trim());
      if (!outputName || !/\.xlsx$/i.test(outputName)) {
        return {
          content: [{ type: "text" as const, text: "outputName 必须是 .xlsx 文件名" }],
          isError: true as const,
        };
      }
      const outputPath = path.join(options.outputDir, outputName);

      const result = await spreadsheetPatchWorkbook(resolvedSource, outputPath, args.edits);
      if (!result.ok || !result.data) {
        return {
          content: [{
            type: "text" as const,
            text: `修改失败（${result.errorCode ?? "unknown"}）：${result.detail ?? ""}`,
          }],
          isError: true as const,
        };
      }
      const data = result.data;
      const lines = [
        `已写入 ${outputPath}`,
        `应用 ${data.applied.length} 处改动；公式 ${data.formulaCount} 条，其中 ${data.cachedValueCount} 条保有缓存值。`,
      ];
      if (data.createdSheets.length) {
        lines.push(`新建工作表：${data.createdSheets.join("、")}`);
      }
      if (data.missing.length) {
        lines.push(
          `未应用 ${data.missing.length} 处：` +
            data.missing.map((item) => `${item.sheet}!${item.cell}(${item.reason})`).join("、"),
        );
      }
      // 只给 formula 不给 value 的格子本会变成「无缓存值的公式」——读回是空的。
      // 引擎已自动补算;补不出的必须明说,否则模型会以为工具写坏了,转而用
      // openpyxl 重写去「修」,那一步会清空整册缓存(HISTORY-001 就是这么毁的)。
      const explicitBackfilled = data.backfilled.filter((item) => item.reason === "explicit");
      const downstreamBackfilled = data.backfilled.filter((item) => item.reason === "downstream");
      if (data.formulaOnlyCount > 0) {
        lines.push(
          `其中 ${data.formulaOnlyCount} 条只写了公式未给结果，已由公式引擎自动补算 ${explicitBackfilled.length} 条。`,
        );
      }
      if (downstreamBackfilled.length > 0) {
        lines.push(
          `你的改动使 ${downstreamBackfilled.length} 条既有公式的输入发生变化，已自动重算并更新缓存` +
            `（无需你再手动核对或用脚本重写）：`,
          ...downstreamBackfilled.slice(0, 20).map((item) => `  ${item.sheet}!${item.cell} = ${item.value}`),
          downstreamBackfilled.length > 20 ? `  …另有 ${downstreamBackfilled.length - 20} 条` : "",
        );
      }
      if (data.engineNote) {
        lines.push(`⚠️ 公式引擎不可用（${data.engineNote}），下面列出的单元格暂时读不出新数值，原缓存已原样保留。`);
      }
      if (data.unresolvedFormulaCells.length > 0) {
        lines.push(
          `⚠️ ${data.unresolvedFormulaCells.length} 条公式引擎算不出结果（多因依赖本机够不到的外部链接），` +
            `这些单元格读回为空是**预期行为，不是写入失败**：`,
          `   ${data.unresolvedFormulaCells.slice(0, 15).join("、")}`,
          `   请在交付说明中标注需人工校验；**不要用 openpyxl 重写工作簿去"修正"，那会清空全部公式缓存值。**`,
        );
      }
      if (data.staleFormulaCount > 0) {
        lines.push(
          `⚠️ ${data.staleFormulaCount} 条既有公式因你的改动而失效，但引擎也算不出新值，原缓存已原样保留、需人工复核：`,
          ...data.staleFormulas.slice(0, 20).map((item) => `  ${item.cell}: ${item.formula}`),
          data.staleFormulaCount > 20 ? `  …另有 ${data.staleFormulaCount - 20} 条` : "",
        );
      }
      return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
    },
  );
}
