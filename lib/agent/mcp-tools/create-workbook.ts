import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import {
  createWorkbookBuffer,
  WORKBOOK_CREATE_LIMITS,
  type WorkbookCellInput,
  type WorkbookSheetInput,
} from "@/lib/workbook-ir";
import type { SdkLike } from "./sdk-types";

const scalar = z.union([z.string().max(WORKBOOK_CREATE_LIMITS.textLength), z.number().finite(), z.boolean(), z.null()]);
const cell = z.union([
  scalar,
  z.object({
    value: scalar.optional(),
    formula: z.string().min(1).max(8_192).optional(),
    result: z.union([z.string().max(WORKBOOK_CREATE_LIMITS.textLength), z.number().finite(), z.boolean()]).optional(),
    numberFormat: z.string().max(128).optional(),
    bold: z.boolean().optional(),
  }).refine((input) => input.formula != null || input.value !== undefined, {
    message: "单元格对象必须提供 value 或 formula",
  }).refine((input) => !(input.formula != null && input.value !== undefined), {
    message: "单元格对象不能同时提供 value 和 formula",
  }).refine((input) => input.formula != null || input.result === undefined, {
    message: "只有公式单元格可以提供 result",
  }),
]);

const sheet = z.object({
  name: z.string().min(1).max(31),
  rows: z.array(z.array(cell).max(WORKBOOK_CREATE_LIMITS.columnsPerSheet)).max(WORKBOOK_CREATE_LIMITS.rowsPerSheet),
  headerRows: z.number().int().min(0).optional(),
  freezeRows: z.number().int().min(0).optional(),
  autoFilter: z.boolean().optional(),
  columnWidths: z.array(z.number().min(2).max(100)).max(WORKBOOK_CREATE_LIMITS.columnsPerSheet).optional(),
});

async function publishWithoutOverwrite(outputDir: string, outputName: string, buffer: Buffer): Promise<string> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(outputDir, `.${randomUUID()}.xlsx.tmp`);
  await writeFile(temporaryPath, buffer, { flag: "wx", mode: 0o600 });
  const extension = path.extname(outputName);
  const stem = path.basename(outputName, extension);
  try {
    for (let sequence = 1; sequence <= 999; sequence += 1) {
      const candidateName = sequence === 1 ? `${stem}${extension}` : `${stem} (${sequence})${extension}`;
      const candidatePath = path.join(outputDir, candidateName);
      try {
        await link(temporaryPath, candidatePath);
        try {
          await chmod(candidatePath, 0o600);
        } catch (error) {
          await unlink(candidatePath).catch(() => undefined);
          throw error;
        }
        return candidatePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("同名输出文件过多，请更换 outputName");
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function createCreateWorkbookTool(
  sdk: SdkLike,
  options: { outputDir: string } = { outputDir: process.cwd() },
) {
  return sdk.tool(
    "create_workbook",
    [
      "从声明式行、单元格和公式创建一个新的 XLSX；不执行 Python、Bash 或任意代码。",
      "生成新工作簿时必须用本工具；已有模板或工作底稿必须改用 patch_workbook，不能重建。",
      "需要汇总时先用 analyze_tabular 得到确定结果，再把明细和公式写入本工具。",
      "公式必须放在 {formula, result?} 对象中；普通字符串即使以 = 开头也会保持为文本。",
      "外部工作簿引用、网络函数和动态数据连接会被拒绝；含公式的正式交付仍需调用 finalize_deliverable 完成重算和错误扫描。",
      `最多 ${WORKBOOK_CREATE_LIMITS.sheets} 个工作表、每表 ${WORKBOOK_CREATE_LIMITS.rowsPerSheet} 行 × ${WORKBOOK_CREATE_LIMITS.columnsPerSheet} 列、总计 ${WORKBOOK_CREATE_LIMITS.totalCells} 个单元格。`,
      "输出只会写入本回合输出目录；同名文件存在时自动生成新名称，绝不覆盖。",
    ].join("\n"),
    {
      outputName: z.string().min(1).max(180).describe("输出 .xlsx 文件名，不含目录"),
      sheets: z.array(sheet).min(1).max(WORKBOOK_CREATE_LIMITS.sheets).describe("工作表与行数据"),
    },
    async (args: { outputName: string; sheets: WorkbookSheetInput[] }) => {
      try {
        const outputName = path.basename(String(args.outputName ?? "").trim());
        if (!outputName || !/\.xlsx$/i.test(outputName)) throw new Error("outputName 必须是 .xlsx 文件名");
        const created = await createWorkbookBuffer({ sheets: args.sheets as Array<WorkbookSheetInput & { rows: WorkbookCellInput[][] }> });
        const outputPath = await publishWithoutOverwrite(options.outputDir, outputName, created.buffer);
        const sha256 = createHash("sha256").update(created.buffer).digest("hex");
        const structuredContent = {
          filePath: outputPath,
          sheetCount: created.sheetCount,
          rowCount: created.rowCount,
          cellCount: created.cellCount,
          formulaCount: created.formulaCount,
          sha256,
        };
        return {
          content: [{
            type: "text" as const,
            text: [
              `已创建 ${outputPath}`,
              `${created.sheetCount} 个工作表，${created.rowCount} 行，${created.cellCount} 个单元格，${created.formulaCount} 条公式。`,
              created.formulaCount > 0
                ? "正式交付前必须调用 finalize_deliverable 完成重算与公式错误扫描。"
                : "正式交付前仍需调用 finalize_deliverable 完成文件验证。",
            ].join("\n"),
          }],
          structuredContent,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `创建工作簿失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const,
        };
      }
    },
  );
}
