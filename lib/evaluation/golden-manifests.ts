import { GoldenManifestSchema, type EvaluationCaseKind, type GoldenManifest, type ScoreDimension } from "./contracts";

const EVIDENCE_TYPES = ["source", "extraction", "transform", "assertion", "delivery"] as const;
const CASES: ReadonlyArray<{
  id: string;
  name: string;
  kind: EvaluationCaseKind;
  goal: string;
  capabilities: string[];
  dimensions: ScoreDimension[];
  output: { mediaType: string; logicalName: string };
}> = [
  {
    id: "golden.consolidation",
    name: "集团合并与抵消",
    kind: "consolidation",
    goal: "基于受控底稿完成集团合并、抵消、勾稽验证并交付不可变工作簿。",
    capabilities: ["document.parse", "workbook.inspect", "workbook.patch", "workbook.recalculate", "finance.consolidation.validate", "artifact.deliver"],
    dimensions: ["contract", "artifact", "evidence", "security", "performance"],
    output: { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", logicalName: "集团合并底稿.xlsx" },
  },
  {
    id: "golden.tax-payroll",
    name: "薪税申报复核",
    kind: "tax_payroll",
    goal: "按实体、期间和税域复核薪资税费，保留口径、异常和人工确认链。",
    capabilities: ["document.parse", "retrieval.hybrid", "finance.tax-payroll.validate", "document.generate", "artifact.deliver"],
    dimensions: ["contract", "artifact", "evidence", "memory", "rag", "security", "performance"],
    output: { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", logicalName: "薪税申报复核.docx" },
  },
  {
    id: "golden.multi-document-rag",
    name: "多文档可追溯问答",
    kind: "multi_document_rag",
    goal: "跨制度、合同和财务材料回答问题，每个事实都能定位到版本化原文。",
    capabilities: ["document.parse", "retrieval.hybrid", "retrieval.rerank", "evidence.cite", "document.generate", "artifact.deliver"],
    dimensions: ["contract", "artifact", "evidence", "memory", "rag", "security", "performance"],
    output: { mediaType: "application/pdf", logicalName: "多文档检索报告.pdf" },
  },
  {
    id: "golden.web-due-diligence",
    name: "联网尽职调查",
    kind: "web_due_diligence",
    goal: "执行可审计的联网尽调，保留查询计划、来源快照、时间戳、冲突与结论。",
    capabilities: ["research.plan", "research.web", "research.snapshot", "evidence.cite", "document.generate", "artifact.deliver"],
    dimensions: ["contract", "artifact", "evidence", "memory", "security", "performance"],
    output: { mediaType: "application/pdf", logicalName: "尽职调查报告.pdf" },
  },
];

function manifestFor(item: (typeof CASES)[number]): GoldenManifest {
  const caseId = `${item.id}.case`;
  const requiredCapabilities = item.capabilities.map((capabilityId) => ({ capabilityId, versionRange: ">=1.0.0", required: true }));
  return GoldenManifestSchema.parse({
    id: item.id,
    version: "1.0.0",
    name: item.name,
    caseKind: item.kind,
    taskContract: {
      id: `${item.id}.task`,
      version: 3,
      goal: item.goal,
      caseId,
      businessContext: {
        entities: [{ id: "entity.demo", type: "company", name: "匿名示例企业" }],
        counterparties: [],
        periods: [{ start: "2026-01-01", end: "2026-06-30", label: "2026 上半年" }],
        effectiveDate: "2026-06-30",
        currencies: [{ code: "CNY", scale: 2 }],
        units: [{ code: "yuan", label: "元", factor: 1 }],
        accountingStandards: ["企业会计准则"],
        jurisdictions: ["CN"],
      },
      inputs: [],
      requiredCapabilities,
      invariants: [
        { id: `${item.id}.artifact-valid`, validatorId: "artifact.integrity", severity: "blocking", parameters: {} },
        { id: `${item.id}.evidence-complete`, validatorId: "evidence.completeness", severity: "blocking", parameters: { types: [...EVIDENCE_TYPES] } },
      ],
      expectedOutputs: [{ id: `${item.id}.output`, ...item.output, count: 1, validatorIds: ["artifact.integrity", "evidence.completeness"], immutableDelivery: true }],
      evidenceRequirements: EVIDENCE_TYPES.map((evidenceType) => ({ evidenceType, minimumCount: 1, requiresLocator: evidenceType === "source" })),
      humanDecisionPoints: [],
      noGuess: ["缺少实体、期间、币种、口径或来源时必须停止并说明缺口"],
      noDegrade: ["不得把未验证结果标记为已交付", "不得用无定位文本替代正式证据"],
      security: {
        classification: "confidential",
        allowedPrincipals: [{ id: "evaluation.service", type: "service", tenantId: "evaluation" }],
        allowExternalEgress: item.kind === "web_due_diligence",
        allowedDomains: item.kind === "web_due_diligence" ? [
          "gov.cn",
          "samr.gov.cn",
          "gsxt.gov.cn",
          "court.gov.cn",
          "creditchina.gov.cn",
          "cninfo.com.cn",
          "sse.com.cn",
          "szse.cn",
        ] : [],
        requireEncryptionAtRest: true,
        requireHumanApprovalForExport: true,
      },
      retention: { policyId: "evaluation-default", legalHold: false, allowUserDeletionRequest: true, gracePeriodDays: 7 },
      budget: {
        tokenLimit: 200_000,
        wallTimeMs: 600_000,
        cpuTimeMs: 300_000,
        memoryBytes: 2_147_483_648,
        diskBytes: 5_368_709_120,
        networkBytes: 536_870_912,
        toolOutputBytes: 268_435_456,
        concurrency: 4,
        retryLimit: 2,
      },
    },
    requiredCapabilities: item.capabilities,
    expectedEvidenceTypes: [...EVIDENCE_TYPES],
    assertions: item.dimensions.map((dimension) => ({ id: `${item.id}.${dimension}`, description: `${item.name} ${dimension} gate`, dimension, blocking: true })),
    thresholds: Object.fromEntries(item.dimensions.map((dimension) => [dimension, dimension === "performance" ? 0.8 : 1])),
  });
}

export const GOLDEN_MANIFESTS: readonly GoldenManifest[] = CASES.map(manifestFor);

export function getGoldenManifest(id: string): GoldenManifest {
  const manifest = GOLDEN_MANIFESTS.find((item) => item.id === id);
  if (!manifest) throw new Error(`golden manifest not found: ${id}`);
  return manifest;
}
