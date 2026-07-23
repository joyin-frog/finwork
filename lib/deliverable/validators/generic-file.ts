import { existsSync, statSync } from "node:fs";
import { sha256File } from "../hash";
import { ALLOWED_DELIVERABLE_MIMES, mimeFromExtension, probeMimeConsistency } from "../mime";
import type { ValidatorIssue, ValidatorResult } from "../types";
import type { ValidatorInput } from "./registry";

const VALIDATOR_ID = "generic_file";

/**
 * 所有文件的基础门：存在、非目录、非空、MIME 一致、扩展名在允许列表。
 * 可打开性：文本类读字节；二进制类至少通过魔数。
 */
export async function validateGenericFile(input: ValidatorInput): Promise<ValidatorResult> {
  const errors: ValidatorIssue[] = [];
  const warnings: ValidatorIssue[] = [];
  let fileSha256 = "";

  try {
    if (!existsSync(input.filePath)) {
      errors.push({ code: "file_not_found", message: "文件不存在" });
      return fail(fileSha256, errors, warnings);
    }
    const st = statSync(input.filePath);
    if (st.isDirectory()) {
      errors.push({ code: "is_directory", message: "不能交付目录" });
      return fail(fileSha256, errors, warnings);
    }
    if (!st.isFile() || st.size <= 0) {
      errors.push({ code: "empty_file", message: "文件大小为零或不是普通文件" });
      return fail(fileSha256, errors, warnings);
    }

    fileSha256 = sha256File(input.filePath);
    if (input.expectedSha256 && input.expectedSha256 !== fileSha256) {
      errors.push({
        code: "hash_mismatch",
        message: "候选文件已变化，旧 validation 失效",
      });
      return fail(fileSha256, errors, warnings);
    }

    const declared = mimeFromExtension(input.fileName);
    if (input.expectedMime && declared !== input.expectedMime && !mimeCompatible(declared, input.expectedMime)) {
      errors.push({
        code: "mime_mismatch",
        message: `扩展名 MIME（${declared}）与合同要求（${input.expectedMime}）不一致`,
      });
    }
    if (!ALLOWED_DELIVERABLE_MIMES.has(declared) && declared !== "application/octet-stream") {
      errors.push({ code: "mime_not_allowed", message: `不允许的交付类型: ${declared}` });
    }

    const probe = probeMimeConsistency(input.filePath, input.fileName);
    if (!probe.consistent) {
      errors.push({
        code: "mime_spoof",
        message: `内容签名与扩展名不一致（content=${probe.contentKind}, declared=${probe.declaredMime}）`,
      });
    }

    // 轻量可打开：文本读一遍；其余魔数已过
    if (declared.startsWith("text/") || declared === "application/json") {
      try {
        const { readFileSync } = await import("node:fs");
        readFileSync(input.filePath, "utf8");
      } catch (e) {
        errors.push({
          code: "parser_open_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    errors.push({
      code: "validator_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (errors.length) return fail(fileSha256, errors, warnings);
  return {
    status: "passed",
    validatorId: VALIDATOR_ID,
    fileSha256,
    errors: [],
    warnings,
    evidence: { sizeBytes: existsSync(input.filePath) ? statSync(input.filePath).size : 0 },
  };
}

function mimeCompatible(actual: string, expected: string): boolean {
  // xlsm 合同若写 xlsx OOXML sheet mime，允许宏簿扩展
  if (
    expected === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" &&
    actual === "application/vnd.ms-excel.sheet.macroEnabled.12"
  ) {
    return true;
  }
  return actual === expected;
}

function fail(fileSha256: string, errors: ValidatorIssue[], warnings: ValidatorIssue[]): ValidatorResult {
  return {
    status: "failed",
    validatorId: VALIDATOR_ID,
    fileSha256,
    errors,
    warnings,
    evidence: {},
  };
}
