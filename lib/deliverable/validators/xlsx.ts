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

/**
 * Office/xlsx 门：复用 CR-S1 spreadsheetInspect / Recalc / Render，不重实现。
 */
export async function validateXlsxFile(input: ValidatorInput): Promise<ValidatorResult> {
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

  const inspected = await spreadsheetInspect(input.filePath);
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

  let formulaCount = 0;
  let emptyCacheCount = 0;
  let formulaErrorCount = 0;
  for (const sheet of sheets) {
    formulaCount += Number(sheet.formula_count ?? 0);
    const samples = (sheet.formulas_sample as Array<{ cell?: string; cached_value?: unknown; formula?: string }>) ?? [];
    for (const f of samples) {
      const cached = f.cached_value;
      if (cached == null || cached === "") emptyCacheCount += 1;
      if (typeof cached === "string" && FORMULA_ERRORS.some((e) => cached.includes(e))) {
        formulaErrorCount += 1;
        errors.push({
          code: "formula_error",
          message: `公式错误值: ${cached}`,
          location: `${String(sheet.name ?? "")}!${f.cell ?? "?"}`,
        });
      }
    }
  }
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
  if (input.needsRecalc) {
    const recalc = await spreadsheetRecalc(input.filePath);
    if (!recalc.ok) {
      errors.push({
        code: recalc.errorCode ?? "recalc_failed",
        message: recalc.detail ?? "公式重算失败",
      });
    } else {
      evidence.recalc = recalc.data;
      // 重算在工作副本上；候选文件 hash 不变。若合同要求缓存，重算成功可清除 empty-cache 硬失败
      if (recalc.data && input.requireFormulaCache) {
        const idx = errors.findIndex((e) => e.code === "formula_cache_empty");
        if (idx >= 0) errors.splice(idx, 1);
      }
    }
  }

  if (input.needsRender) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-deliv-render-"));
    try {
      const render = await spreadsheetRender(input.filePath, outDir);
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
  if (input.expectedSha256 && input.expectedSha256 !== fileSha256) {
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

function fail(
  fileSha256: string,
  errors: ValidatorIssue[],
  warnings: ValidatorIssue[],
  evidence: Record<string, unknown>
): ValidatorResult {
  return { status: "failed", validatorId: VALIDATOR_ID, fileSha256, errors, warnings, evidence };
}
