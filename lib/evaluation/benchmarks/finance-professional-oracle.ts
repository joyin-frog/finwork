import type { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "@/lib/artifacts/store";
import { parseDocumentBytes } from "@/lib/document-ir/adapters";
import { getAppDataDir } from "@/lib/runtime/paths";
import path from "node:path";
import {
  BenchmarkPredictionSchema,
  type BenchmarkEvaluationOracle,
  type BenchmarkExecutionCase,
  type BenchmarkPrediction,
} from "./contracts";

type Rule = {
  /** Every group must contribute at least one matching alternative. */
  allOf: readonly (readonly string[])[];
  /** At least one alternative must have every one of its groups satisfied. */
  alternatives?: readonly (readonly (readonly string[])[])[];
  /** A forbidden term may appear only when an explicit exclusion is present. */
  forbidden?: readonly { terms: readonly string[]; unlessAny: readonly string[] }[];
};

const RULES: Readonly<Record<string, readonly Rule[]>> = {
  "book-01-trial-balance": [
    { allOf: [["借方", "debit"], ["贷方", "credit"], ["52200"]] },
    { allOf: [["差额", "difference"], ["0"]] },
  ],
  "book-02-travel-expense": [
    { allOf: [["差旅", "travel"], ["3600"]] },
    { allOf: [], forbidden: [{ terms: ["办公费", "office expense"], unlessAny: ["不包含办公费", "排除办公费", "exclude office expense"] }] },
  ],
  "book-03-ap-balance": [
    { allOf: [["应付账款", "accounts payable"], ["12000"]] },
    { allOf: [["supplier-a"]] },
  ],
  "book-04-net-revenue": [
    { allOf: [["收入", "revenue"], ["30000"]] },
    { allOf: [["销售退回", "sales return"], ["5000"]] },
    { allOf: [["净收入", "net revenue"], ["25000"]] },
  ],
  "book-05-duplicate-invoice": [
    { allOf: [["sup-2002"], ["两次", "重复", "duplicate", "twice"]] },
    { allOf: [["重复", "duplicate"], ["1"]] },
  ],
  "pay-01-gross-payroll": [
    { allOf: [["基本工资", "base salary"], ["37000"]] },
    { allOf: [["奖金", "bonus"], ["6000"]] },
    { allOf: [["工资总额", "gross payroll"], ["43000"]] },
  ],
  "pay-02-employee-deductions": [
    { allOf: [["员工社保", "employee social"], ["5500"]] },
    { allOf: [["个税", "tax"], ["3300"]] },
    { allOf: [["扣款", "deduction"], ["8800"]] },
  ],
  "pay-03-net-pay": [
    { allOf: [["实发", "net pay"], ["34200"]] },
    {
      allOf: [["工资总额", "gross"], ["实发", "net pay"]],
      alternatives: [
        [["扣款", "deduction"]],
        [["员工社保", "employee social"], ["个税", "tax"]],
      ],
    },
  ],
  "pay-04-employer-cost": [
    { allOf: [["公司社保", "employer social"], ["7600"]] },
    { allOf: [["人工总成本", "employer cost", "total cost"], ["50600"]] },
  ],
  "pay-05-headcount": [
    { allOf: [["员工总数", "headcount"], ["3"]] },
    { allOf: [["finance"], ["operations"], ["sales"], ["1"]] },
  ],
  "treasury-01-outstanding": [
    { allOf: [["未收", "outstanding"], ["70000"]] },
    { allOf: [], forbidden: [{ terms: ["ar-002"], unlessAny: ["不进入", "排除", "已结清", "excluded", "settled"] }] },
  ],
  "treasury-02-overdue": [
    { allOf: [["ar-001"], ["20000"]] },
    { allOf: [["ar-003"], ["45000"]] },
    { allOf: [["逾期", "overdue"], ["65000"]] },
  ],
  "treasury-03-bank-reconcile": [
    { allOf: [["ar-004"], ["5000"], ["4500"]] },
    { allOf: [["差异", "difference"], ["500"]] },
  ],
  "treasury-04-concentration": [
    { allOf: [["customer-c"]] },
    { allOf: [["64.29", "0.6429"]] },
  ],
  "treasury-05-next-due": [
    { allOf: [["ar-004"], ["尚未逾期", "not overdue", "未到期"]] },
    { allOf: [["待收", "outstanding"], ["5000"]] },
  ],
  "mgmt-01-quarter-revenue": [
    { allOf: [["实际收入", "actual revenue"], ["330000"]] },
    { allOf: [["预算收入", "budget revenue"], ["310000"]] },
  ],
  "mgmt-02-revenue-variance": [
    { allOf: [["收入", "revenue"], ["差异", "variance"], ["20000"]] },
    { allOf: [["达成率", "attainment"], ["106.45", "1.0645"]] },
  ],
  "mgmt-03-cost-variance": [
    { allOf: [["实际成本", "actual cost"], ["223000"]] },
    { allOf: [["预算成本", "budget cost"], ["215000"]] },
    { allOf: [["超预算", "unfavorable", "over budget"], ["8000"]] },
  ],
  "mgmt-04-profit-variance": [
    { allOf: [["实际利润", "actual profit"], ["107000"]] },
    { allOf: [["预算利润", "budget profit"], ["95000"]] },
    { allOf: [["利润", "profit"], ["差异", "variance"], ["12000"]] },
  ],
  "mgmt-05-june-margin": [
    { allOf: [["6月", "june"], ["利润", "profit"], ["40000"]] },
    { allOf: [["利润率", "margin"], ["33.33", "0.3333"]] },
  ],
  "doc-01-board-date": [
    { allOf: [["2026-07-18"]] },
    { allOf: [["board-minute"], ["page:2"]] },
  ],
  "doc-02-tax-reconcile": [
    { allOf: [["43000"], ["8800"], ["34200"]] },
    { allOf: [["43000"], ["8800"], ["34200"]] },
  ],
  "doc-03-supplier-status": [
    { allOf: [["supplier-a"], ["2026-12-31"]] },
    { allOf: [["supplier-b"], ["conditional", "有条件"]] },
  ],
  "doc-04-service-fee": [
    { allOf: [["2.5%", "0.025"]] },
    { allOf: [["争议回款", "disputed receipts"], ["排除", "exclude"]] },
  ],
  "doc-05-audit-finding": [
    { allOf: [["sup-2002"], ["重复", "duplicate", "twice"]] },
    { allOf: [["结算前", "before settlement"], ["复核", "review"]] },
  ],
  "gov-01-policy-freshness": [
    { allOf: [["travel-v2"], ["active", "生效"]] },
    { allOf: [["1500"], ["草案", "draft"], ["不得采用", "不采用", "reject"]] },
  ],
  "gov-02-version-conflict": [
    { allOf: [["1200"], ["1500"], ["冲突", "conflict"]] },
    { allOf: [["1200"], ["现行", "current", "active"]] },
  ],
  "gov-03-source-trust": [
    { allOf: [["6%", "6％", "0.06", "6 percent"]] },
    { allOf: [["blog"], ["过时", "outdated"], ["拒绝", "不采用", "reject"]] },
  ],
  "gov-04-memory-carry": [
    { allOf: [["finwork synthetic co"]] },
    { allOf: [["cny"]] },
    { allOf: [["2026q2", "2026 q2"]] },
  ],
  "gov-05-expiry-delete": [
    { allOf: [["cc-old"], ["过期", "expired"], ["不使用", "不得继续使用", "禁止继续使用", "不再作为有效", "排除", "exclude"]] },
    { allOf: [["银行账号", "bank account"], ["不恢复", "不得恢复", "不输出", "不得输出", "保持删除", "维持删除", "remain deleted"]] },
  ],
};

export type FinanceProfessionalBusinessAssertionResult = {
  assertion: string;
  passed: boolean;
  missingGroups: string[][];
  forbiddenTerms: string[];
};

export function evaluateFinanceProfessionalBusinessText(
  upstreamCaseId: string,
  expectedAssertions: readonly string[],
  text: string,
): FinanceProfessionalBusinessAssertionResult[] {
  validateFinanceProfessionalOracleCoverage(upstreamCaseId, expectedAssertions);
  const normalizedText = normalize(text);
  return RULES[upstreamCaseId]!.map((rule, index): FinanceProfessionalBusinessAssertionResult => {
    const missingRequired = missingGroupsFor(rule.allOf, normalizedText);
    const alternativeMissing = (rule.alternatives ?? []).map((alternative) =>
      missingGroupsFor(alternative, normalizedText)
    );
    const bestAlternativeMissing = alternativeMissing.length === 0
      ? []
      : alternativeMissing.reduce((best, current) => current.length < best.length ? current : best);
    const missingGroups = [
      ...missingRequired,
      ...(alternativeMissing.length > 0 && !alternativeMissing.some((missing) => missing.length === 0)
        ? bestAlternativeMissing
        : []),
    ];
    const forbiddenTerms = (rule.forbidden ?? []).flatMap((item) => {
      const present = item.terms.some((term) => normalizedText.includes(normalize(term)));
      const explicitlyExcluded = item.unlessAny.some((term) => normalizedText.includes(normalize(term)));
      return present && !explicitlyExcluded ? [...item.terms] : [];
    });
    return {
      assertion: expectedAssertions[index]!,
      passed: missingGroups.length === 0 && forbiddenTerms.length === 0,
      missingGroups,
      forbiddenTerms,
    };
  });
}

export function validateFinanceProfessionalOracleCoverage(
  upstreamCaseId: string,
  expectedAssertions: readonly string[],
): void {
  const rules = RULES[upstreamCaseId];
  if (!rules || rules.length !== expectedAssertions.length) {
    throw new Error(`finance_professional_business_oracle_missing:${upstreamCaseId}`);
  }
}

export async function validateFinanceProfessionalBusinessAssertions(input: {
  executionCase: BenchmarkExecutionCase;
  oracle: BenchmarkEvaluationOracle;
  prediction: BenchmarkPrediction;
  db: DatabaseSync;
  casRoot?: string;
  readArtifact?: (versionId: string) => Uint8Array;
}): Promise<BenchmarkPrediction> {
  if (input.executionCase.datasetId !== "finance_agent_professional") return input.prediction;
  const expected = input.oracle.expected.assertions;
  validateFinanceProfessionalOracleCoverage(input.executionCase.upstreamCaseId, expected);
  const delivered = input.prediction.execution?.artifactRefs.find((artifact) =>
    artifact.state === "delivered"
    && artifact.mediaType === input.oracle.expected.artifact?.mediaType
    && artifact.logicalName === input.oracle.expected.artifact?.logicalName
  );
  let text = "";
  let extractionError: string | null = null;
  if (!delivered) {
    extractionError = "delivered_artifact_missing";
  } else {
    try {
      const read = input.readArtifact ?? ((versionId: string) => new ArtifactStore(
        input.db,
        input.casRoot ?? path.join(getAppDataDir(), "artifacts", "cas"),
      ).read(versionId));
      text = await extractArtifactText(read(delivered.versionId), delivered.mediaType);
    } catch (error) {
      extractionError = error instanceof Error ? error.message : String(error);
    }
  }
  const results = evaluateFinanceProfessionalBusinessText(
    input.executionCase.upstreamCaseId,
    expected,
    text,
  ).map((result) => extractionError === null ? result : { ...result, passed: false });
  const expectedNormalized = new Set(expected.map(normalize));
  const nonBusinessAssertions = input.prediction.assertions.filter((value) => !expectedNormalized.has(normalize(value)));
  return BenchmarkPredictionSchema.parse({
    ...input.prediction,
    assertions: [
      ...nonBusinessAssertions,
      ...results.filter((result) => result.passed).map((result) => result.assertion),
    ],
    details: {
      ...(isObject(input.prediction.details) ? input.prediction.details : {}),
      financeProfessionalBusinessAssertions: {
        extractionError,
        artifactVersionId: delivered?.versionId ?? null,
        textLength: text.length,
        total: results.length,
        passed: results.filter((result) => result.passed).length,
        results,
      },
    },
  });
}

async function extractArtifactText(bytes: Uint8Array, mediaType: string): Promise<string> {
  const format = mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ? "xlsx"
    : mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ? "docx"
      : mediaType === "application/pdf"
        ? "pdf"
        : null;
  if (format) {
    const document = await parseDocumentBytes(format, bytes);
    return document.nodes.flatMap((node) => node.text ? [node.text] : []).join("\n");
  }
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    return Buffer.from(bytes).toString("utf8");
  }
  throw new Error(`finance_professional_artifact_text_unsupported:${mediaType}`);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[\s，,:：;；'"`()[\]{}]+/g, "")
    .trim();
}

function missingGroupsFor(groups: readonly (readonly string[])[], normalizedText: string): string[][] {
  return groups
    .filter((group) => !group.some((term) => normalizedText.includes(normalize(term))))
    .map((group) => [...group]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
