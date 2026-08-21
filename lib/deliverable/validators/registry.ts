import type { QualityProfile, DeliverySpec } from "@/lib/agent/run-contract";
import type { ValidatorResult } from "../types";
import { validateGenericFile } from "./generic-file";
import { validateDocxFile } from "./docx";
import { validateXlsxFile } from "./xlsx";
import { validateFinancialConsolidation } from "./financial-consolidation";

export type ValidatorInput = {
  filePath: string;
  fileName: string;
  expectedMime: string;
  qualityProfile: QualityProfile;
  /** 绑定校验时的候选 hash；变化则失效 */
  expectedSha256?: string;
  needsRecalc?: boolean;
  /** 正式交付必须有真实重算 Provider；普通诊断可保留 best_effort。 */
  recalcPolicy?: "required" | "best_effort";
  needsRender?: boolean;
  /** Profile 要求公式缓存非空（公式型交付） */
  requireFormulaCache?: boolean;
  expectationSnapshot?: DeliverySpec["expectationSnapshot"];
};

export type DeliverableValidator = {
  id: string;
  /** 是否可处理该 MIME + profile */
  matches: (mime: string, profile: QualityProfile) => boolean;
  validate: (input: ValidatorInput) => Promise<ValidatorResult>;
};

const registry: DeliverableValidator[] = [];

export function registerValidator(v: DeliverableValidator): void {
  const idx = registry.findIndex((x) => x.id === v.id);
  if (idx >= 0) registry[idx] = v;
  else registry.push(v);
}

export function listValidators(): readonly DeliverableValidator[] {
  return registry;
}

export function selectValidator(mime: string, profile: QualityProfile): DeliverableValidator {
  // 模型不能降低 Profile：按合同 profile + MIME 选择；找不到则失败用的 sentinel
  const hit = registry.find((v) => v.matches(mime, profile));
  if (hit) return hit;
  return {
    id: "no_validator",
    matches: () => false,
    validate: async (input) => ({
      status: "failed",
      validatorId: "no_validator",
      fileSha256: input.expectedSha256 ?? "",
      errors: [
        {
          code: "no_validator",
          message: `无可用 validator（mime=${mime}, profile=${profile}）`,
        },
      ],
      warnings: [],
      evidence: {},
    }),
  };
}

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel",
]);
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** 注册通用 file + xlsx validators（幂等）。 */
export function ensureBuiltinValidatorsRegistered(): void {
  if (registry.some((v) => v.id === "generic_file")) return;

  registerValidator({
    id: "docx_generic",
    matches: (mime) => mime === DOCX_MIME,
    validate: async (input) => validateDocxFile(input),
  });

  registerValidator({
    id: "generic_file",
    matches: (mime, _profile) =>
      !SPREADSHEET_MIMES.has(mime) && mime !== DOCX_MIME,
    validate: async (input) => validateGenericFile(input),
  });

  registerValidator({
    id: "xlsx_generic",
    matches: (mime, profile) => SPREADSHEET_MIMES.has(mime) && profile === "generic",
    validate: async (input) => validateXlsxFile(input),
  });

  registerValidator({
    id: "xlsx_financial_consolidation",
    matches: (mime, profile) => SPREADSHEET_MIMES.has(mime) && profile === "financial_consolidation",
    validate: async (input) => validateFinancialConsolidation(input),
  });
}
