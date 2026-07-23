import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spreadsheetInspect, spreadsheetRecalc, spreadsheetRender } from "@/lib/runtime/spreadsheet-runtime";
import { sha256File } from "../hash";
import { probeMimeConsistency } from "../mime";
import type { ValidatorIssue, ValidatorResult } from "../types";
import type { ValidatorInput } from "./registry";
import { validateGenericFile } from "./generic-file";

const VALIDATOR_ID = "xlsx_generic";
const FORMULA_ERRORS = ["#DIV/0!", "#REF!", "#VALUE!", "#NAME?", "#NULL!", "#NUM!", "#N/A"];
type XlsxRuntime = {
  inspect: typeof spreadsheetInspect;
  recalc: typeof spreadsheetRecalc;
  render: typeof spreadsheetRender;
};
const DEFAULT_RUNTIME: XlsxRuntime = {
  inspect: spreadsheetInspect,
  recalc: spreadsheetRecalc,
  render: spreadsheetRender,
};

/**
 * Office/xlsx 门：复用 CR-S1 spreadsheetInspect / Recalc / Render，不重实现。
 */
export async function validateXlsxFile(
  input: ValidatorInput,
  runtime: XlsxRuntime = DEFAULT_RUNTIME,
): Promise<ValidatorResult> {
  const base = await validateGenericFile({ ...input, expectedMime: input.expectedMime });
  const errors: ValidatorIssue[] = [...base.errors];
  const warnings: ValidatorIssue[] = [...base.warnings];
  let fileSha256 = base.fileSha256;
  const evidence: Record<string, unknown> = { ...base.evidence, baseValidator: base.validatorId };

  if (base.status === "failed" && base.errors.some((e) => e.code !== "mime_not_allowed")) {
    // 基础门已失败则不再跑 LO（除 MIME 白名单细节）
    if (base.errors.some((e) => ["file_not_found", "empty_file", "is_directory", "mime_spoof", "hash_mismatch"].includes(e.code))) {
      return { status: "failed", validatorId: VALIDATOR_ID, fileSha256, errors, warnings, evidence };
    }
  }

  const probe = probeMimeConsistency(input.filePath, input.fileName);
  if (!probe.consistent || probe.contentKind !== "zip") {
    // .xls OLE 另议；v1 正式交付偏好 xlsx
    if (input.fileName.toLowerCase().endsWith(".xls")) {
      errors.push({ code: "legacy_xls", message: "正式交付请使用 .xlsx（.xls 需先转换）" });
      return fail(fileSha256, errors, warnings, evidence);
    }
  }

  const inspected = await runtime.inspect(input.filePath);
  if (!inspected.ok) {
    errors.push({
      code: "parser_open_failed",
      message: inspected.detail ?? "无法打开工作簿",
      location: inspected.errorCode,
    });
    return fail(fileSha256, errors, warnings, evidence);
  }
  evidence.inspect = inspected.data;

  const sheets = (inspected.data as { sheets?: Array<Record<string, unknown>> })?.sheets ?? [];
  if (sheets.length === 0) {
    errors.push({ code: "structure_empty", message: "工作簿无工作表" });
  }

  const initialFormulaState = analyzeFormulaState(sheets);
  let formulaCount = initialFormulaState.formulaCount;
  let emptyCacheCount = initialFormulaState.emptyCacheCount;
  let formulaErrorCount = initialFormulaState.formulaErrors.length;
  errors.push(...initialFormulaState.formulaErrors);
  evidence.formulaCount = formulaCount;
  evidence.emptyCacheCount = emptyCacheCount;

  if (input.requireFormulaCache && formulaCount > 0 && emptyCacheCount > 0) {
    errors.push({
      code: "formula_cache_empty",
      message: "Profile 要求公式缓存非空，但存在未缓存结果的公式（需先重算）",
    });
  } else if (emptyCacheCount > 0 && formulaCount > 0) {
    warnings.push({
      code: "formula_cache_empty",
      message: "部分公式无缓存结果",
    });
  }

  // Recalc（合同要求时）— 消费 CR-S1，不重实现
  let candidateRecalculated = false;
  if (input.needsRecalc) {
    const recalc = await runtime.recalc(input.filePath);
    if (!recalc.ok) {
      errors.push({
        code: recalc.errorCode ?? "recalc_failed",
        message: recalc.detail ?? "公式重算失败",
      });
    } else {
      const recalcData = recalc.data;
      if (!recalcData?.outputPath) {
        errors.push({
          code: "recalc_output_missing",
          message: "公式重算未返回可交付工作簿",
        });
      } else {
        const { outputPath, cleanupRoot, ...recalcEvidence } = recalcData;
        evidence.recalc = recalcEvidence;
        try {
          const verified = await runtime.inspect(outputPath);
          if (!verified.ok) {
            errors.push({
              code: "recalc_verify_failed",
              message: verified.detail ?? "重算后的工作簿无法重新检查",
              location: verified.errorCode,
            });
          } else {
            const verifiedSheets =
              (verified.data as { sheets?: Array<Record<string, unknown>> })?.sheets ?? [];
            const verifiedFormulaState = analyzeFormulaState(verifiedSheets);
            evidence.recalcInspect = verified.data;
            evidence.recalcEmptyCacheCount = verifiedFormulaState.emptyCacheCount;
            if (verifiedSheets.length === 0) {
              errors.push({
                code: "recalc_structure_empty",
                message: "重算后的工作簿无工作表",
              });
            } else if (verifiedFormulaState.formulaErrors.length > 0) {
              errors.push(...verifiedFormulaState.formulaErrors);
            } else if (input.requireFormulaCache && verifiedFormulaState.emptyCacheCount > 0) {
              errors.push({
                code: "recalc_cache_empty",
                message: "重算后的工作簿仍存在未缓存结果的公式",
              });
            } else {
              fs.copyFileSync(outputPath, input.filePath);
              candidateRecalculated = true;
              removeIssues(errors, new Set(["formula_cache_empty", "formula_error", "structure_empty"]));
              formulaCount = verifiedFormulaState.formulaCount;
              emptyCacheCount = verifiedFormulaState.emptyCacheCount;
              formulaErrorCount = 0;
              evidence.formulaCount = formulaCount;
              evidence.emptyCacheCount = emptyCacheCount;
            }
          }
        } catch (error) {
          errors.push({
            code: "recalc_promote_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          cleanupRecalcRoot(cleanupRoot, outputPath);
        }
      }
    }
  }

  if (input.needsRender) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-deliv-render-"));
    try {
      const render = await runtime.render(input.filePath, outDir);
      if (!render.ok) {
        errors.push({
          code: render.errorCode ?? "render_failed",
          message: render.detail ?? "渲染可见页面失败",
        });
      } else {
        evidence.render = { files: render.data?.files?.length ?? 0, provider: render.data?.provider };
      }
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // 重新哈希（确保过程中未改候选）
  fileSha256 = sha256File(input.filePath);
  if (!candidateRecalculated && input.expectedSha256 && input.expectedSha256 !== fileSha256) {
    errors.push({ code: "hash_mismatch", message: "校验过程中候选文件被修改" });
  }

  if (errors.length) return fail(fileSha256, errors, warnings, evidence);
  return {
    status: "passed",
    validatorId: VALIDATOR_ID,
    fileSha256,
    errors: [],
    warnings,
    evidence: { ...evidence, formulaErrorCount },
  };
}

function analyzeFormulaState(sheets: Array<Record<string, unknown>>): {
  formulaCount: number;
  emptyCacheCount: number;
  formulaErrors: ValidatorIssue[];
} {
  let formulaCount = 0;
  let emptyCacheCount = 0;
  const formulaErrors: ValidatorIssue[] = [];
  for (const sheet of sheets) {
    formulaCount += Number(sheet.formula_count ?? 0);
    const samples =
      (sheet.formulas_sample as Array<{ cell?: string; cached_value?: unknown }> | undefined) ?? [];
    for (const formula of samples) {
      const cached = formula.cached_value;
      if (cached == null || cached === "") emptyCacheCount += 1;
      if (typeof cached === "string" && FORMULA_ERRORS.some((e) => cached.includes(e))) {
        formulaErrors.push({
          code: "formula_error",
          message: `公式错误值: ${cached}`,
          location: `${String(sheet.name ?? "")}!${formula.cell ?? "?"}`,
        });
      }
    }
  }
  return { formulaCount, emptyCacheCount, formulaErrors };
}

function removeIssues(errors: ValidatorIssue[], codes: Set<string>): void {
  for (let i = errors.length - 1; i >= 0; i -= 1) {
    if (codes.has(errors[i]!.code)) errors.splice(i, 1);
  }
}

function cleanupRecalcRoot(cleanupRoot: string | undefined, outputPath: string): void {
  if (!cleanupRoot) return;
  const root = path.resolve(cleanupRoot);
  const tempRoot = path.resolve(os.tmpdir());
  const output = path.resolve(outputPath);
  if (
    path.dirname(root) !== tempRoot ||
    !path.basename(root).startsWith("fa-recalc-") ||
    (output !== root && !output.startsWith(`${root}${path.sep}`))
  ) {
    return;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function fail(
  fileSha256: string,
  errors: ValidatorIssue[],
  warnings: ValidatorIssue[],
  evidence: Record<string, unknown>
): ValidatorResult {
  return { status: "failed", validatorId: VALIDATOR_ID, fileSha256, errors, warnings, evidence };
}
