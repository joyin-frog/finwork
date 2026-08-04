import { statSync } from "node:fs";
import { sha256File } from "../hash";
import type { ValidatorIssue, ValidatorResult } from "../types";
import type { ValidatorInput } from "./registry";
import { validateGenericFile } from "./generic-file";

const VALIDATOR_ID = "docx_generic";

/** DOCX 基础质量门：魔数/MIME 通过后，必须能解析出非空正文。 */
export async function validateDocxFile(input: ValidatorInput): Promise<ValidatorResult> {
  const base = await validateGenericFile(input);
  const errors: ValidatorIssue[] = [...base.errors];
  const warnings: ValidatorIssue[] = [...base.warnings];
  if (base.status === "failed") {
    return {
      status: "failed",
      validatorId: VALIDATOR_ID,
      fileSha256: base.fileSha256,
      errors,
      warnings,
      evidence: base.evidence,
    };
  }

  let text = "";
  try {
    const mammoth = await import("mammoth");
    const extracted = await mammoth.extractRawText({ path: input.filePath });
    text = extracted.value.trim();
    for (const message of extracted.messages) {
      warnings.push({
        code: "docx_parser_warning",
        message: String(message.message ?? message.type ?? "DOCX 解析警告"),
      });
    }
  } catch (error) {
    errors.push({
      code: "parser_open_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!text) {
    errors.push({ code: "document_empty", message: "DOCX 未解析出可读正文" });
  }
  const fileSha256 = sha256File(input.filePath);
  if (input.expectedSha256 && input.expectedSha256 !== fileSha256) {
    errors.push({ code: "hash_mismatch", message: "校验过程中候选文件被修改" });
  }
  if (errors.length) {
    return {
      status: "failed",
      validatorId: VALIDATOR_ID,
      fileSha256,
      errors,
      warnings,
      evidence: { ...base.evidence, textLength: text.length },
    };
  }
  return {
    status: "passed",
    validatorId: VALIDATOR_ID,
    fileSha256,
    errors: [],
    warnings,
    evidence: {
      ...base.evidence,
      sizeBytes: statSync(input.filePath).size,
      textLength: text.length,
    },
  };
}
