import { TaskContractV3Schema, type TaskContractV3 } from "@/lib/task/contracts";
import type { TaskContract } from "@/lib/agent/run-contract";
import type { BenchmarkCapability, BenchmarkExecutionCase } from "./contracts";

const SPREADSHEET_OUTPUT_MEDIA_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/tab-separated-values",
]);

function isSpreadsheetOutput(mediaType: string, logicalName: string): boolean {
  return SPREADSHEET_OUTPUT_MEDIA_TYPES.has(mediaType.toLowerCase())
    || /\.(?:csv|tsv|xls|xlsx|xlsm)$/i.test(logicalName);
}

/**
 * Pi and finalize_deliverable still consume TaskContract v1. Benchmark
 * execution derives that compatibility view from the explicit V3 output
 * contract, never from input attachments: an input workbook does not imply
 * that the user requested a workbook deliverable.
 */
export function createLegacyBenchmarkTaskContract(contract: TaskContractV3): TaskContract {
  const spreadsheetOutput = contract.expectedOutputs.some((output) =>
    isSpreadsheetOutput(output.mediaType, output.logicalName)
  );
  return {
    version: 1,
    taskKind: spreadsheetOutput ? "spreadsheet" : "text",
    ...(spreadsheetOutput ? {
      spreadsheetRequirement: {
        needsLegacyXlsRead: false,
        needsWrite: true,
        needsRecalc: false,
        needsRender: false,
        needsMacroPreservation: contract.expectedOutputs.some((output) =>
          /\.xlsm$/i.test(output.logicalName)
          || output.mediaType.toLowerCase() === "application/vnd.ms-excel.sheet.macroenabled.12"
        ),
      },
    } : {}),
    requiredDeliverables: contract.expectedOutputs.map((output) => ({
      id: output.id,
      mime: output.mediaType,
      count: output.count,
      qualityProfile: "generic" as const,
    })),
    expectationSnapshot: {},
  };
}

/**
 * Map benchmark taxonomy to capabilities that the production execution ledger
 * can actually prove. Answer correctness remains the private Oracle's job;
 * reasoning labels must not become fictitious tool-execution requirements.
 */
const EXECUTION_CAPABILITY_IDS: Readonly<Record<BenchmarkCapability, readonly string[]>> = {
  financial_qa: ["agent.turn"],
  table_reasoning: ["agent.turn"],
  multi_turn_reasoning: ["agent.turn"],
  retrieval: ["retrieval.search"],
  citation: ["retrieval.search"],
  financial_knowledge: ["agent.turn"],
  spreadsheet_understanding: ["spreadsheet.read"],
  spreadsheet_editing: ["spreadsheet.write", "spreadsheet.validate"],
  agent_tool_use: ["agent.turn"],
  quantitative_finance: ["agent.turn"],
  due_diligence: ["research.web"],
  policy_compliance: ["agent.turn"],
  stateful_tool_use: ["agent.turn"],
  clarification: ["agent.turn"],
  error_recovery: ["agent.turn"],
  security_resistance: ["agent.turn"],
};

const SEMANTIC_CAPABILITY_IDS: Readonly<Record<BenchmarkCapability, string>> = {
  financial_qa: "finance.reasoning.answer",
  table_reasoning: "document.table.extract",
  multi_turn_reasoning: "agent.context.reason",
  retrieval: "retrieval.search",
  citation: "evidence.citation",
  financial_knowledge: "finance.knowledge.answer",
  spreadsheet_understanding: "workbook.read",
  spreadsheet_editing: "workbook.patch",
  agent_tool_use: "agent.tool-orchestrate",
  quantitative_finance: "finance.rules.evaluate",
  due_diligence: "research.web",
  policy_compliance: "agent.policy-comply",
  stateful_tool_use: "agent.stateful-tool-use",
  clarification: "agent.clarify",
  error_recovery: "agent.error-recover",
  security_resistance: "agent.security-resist",
};

export interface BenchmarkTaskContractOptions {
  tenantId?: string;
  principalId?: string;
  wallTimeMs?: number;
  tokenLimit?: number;
  memoryBytes?: number;
}

export interface BenchmarkTaskMaterialization {
  contract: TaskContractV3;
  missingExternalInputs: Array<{
    logicalName: string;
    mediaType: string;
    upstreamUri?: string;
  }>;
}

export function createBenchmarkTaskContract(
  benchmarkCase: BenchmarkExecutionCase,
  options: BenchmarkTaskContractOptions = {},
): BenchmarkTaskMaterialization {
  const inputArtifacts = benchmarkCase.inputs;
  const artifactKeys = new Set(inputArtifacts.map((artifact) => `${artifact.logicalName}\u0000${artifact.mediaType}`));
  const missingExternalInputs = benchmarkCase.context.files
    .filter((file) => !file.artifactRef && !artifactKeys.has(`${file.logicalName}\u0000${file.mediaType}`))
    .map((file) => ({
      logicalName: file.logicalName,
      mediaType: file.mediaType,
      ...(file.upstreamUri ? { upstreamUri: file.upstreamUri } : {}),
    }));

  const evidenceRequirements: TaskContractV3["evidenceRequirements"] = [];
  if (benchmarkCase.requirements.requiresSourceEvidence) {
    evidenceRequirements.push({ evidenceType: "source", minimumCount: 1, requiresLocator: true });
  }
  if (benchmarkCase.requirements.requiresCitations) {
    evidenceRequirements.push({ evidenceType: "extraction", minimumCount: 1, requiresLocator: true });
  }
  if (benchmarkCase.requirements.artifactOutput) {
    evidenceRequirements.push(
      { evidenceType: "transform", minimumCount: 1, requiresLocator: true },
      { evidenceType: "assertion", minimumCount: 1, requiresLocator: true },
      { evidenceType: "delivery", minimumCount: 1, requiresLocator: false },
    );
  }

  const expectedOutputs: TaskContractV3["expectedOutputs"] = benchmarkCase.requirements.artifactOutput
    ? [{
        id: "benchmark-output",
        mediaType: benchmarkCase.requirements.artifactOutput.mediaType,
        logicalName: benchmarkCase.requirements.artifactOutput.logicalName,
        count: 1,
        validatorIds: benchmarkCase.requirements.artifactOutput.validatorIds,
        immutableDelivery: true,
      }]
    : [];

  const contract = TaskContractV3Schema.parse({
    id: `benchmark-task:${benchmarkCase.id}`.slice(0, 200),
    version: 3,
    goal: benchmarkCase.prompt,
    caseId: benchmarkCase.id,
    businessContext: {
      entities: [],
      counterparties: [],
      periods: [],
      currencies: [],
      units: [],
      accountingStandards: [],
      jurisdictions: [],
    },
    inputs: inputArtifacts,
    requiredCapabilities: [
      ...[...new Set([
        "agent.turn",
        ...benchmarkCase.capabilities.flatMap((capability) => EXECUTION_CAPABILITY_IDS[capability]),
      ])].map((capabilityId) => ({ capabilityId, versionRange: "^1.0.0", required: true })),
      ...[...new Set(benchmarkCase.capabilities.map((capability) => SEMANTIC_CAPABILITY_IDS[capability]))]
        .filter((capabilityId) => ![
          "agent.turn",
          ...benchmarkCase.capabilities.flatMap((capability) => EXECUTION_CAPABILITY_IDS[capability]),
        ].includes(capabilityId))
        .map((capabilityId) => ({ capabilityId, versionRange: "^1.0.0", required: false })),
    ],
    invariants: benchmarkCase.requirements.artifactOutput
      ? [{
          id: "task-contract-delivery-gate",
          validatorId: "task-contract.delivery-gate",
          severity: "blocking",
          parameters: {
            expectedOutputId: "benchmark-output",
            validatorIds: benchmarkCase.requirements.artifactOutput.validatorIds,
          },
        }]
      : [],
    expectedOutputs,
    evidenceRequirements,
    humanDecisionPoints: [],
    noGuess: [
      "Do not invent source evidence, citations, workbook cells, or financial facts.",
      "Do not treat model self-report as deterministic validation.",
    ],
    noDegrade: [
      "Do not replace a required artifact with a textual summary.",
      "Do not publish a score when required artifact checks or source materialization are missing.",
    ],
    security: {
      classification: "public",
      allowedPrincipals: [{
        id: options.principalId ?? "benchmark-runner",
        type: "service",
        tenantId: options.tenantId ?? "benchmark",
      }],
      allowExternalEgress: false,
      allowedDomains: [],
      requireEncryptionAtRest: true,
      requireHumanApprovalForExport: false,
    },
    retention: {
      policyId: "benchmark-ephemeral",
      legalHold: false,
      allowUserDeletionRequest: true,
      gracePeriodDays: 0,
    },
    budget: {
      tokenLimit: options.tokenLimit ?? 32_000,
      wallTimeMs: options.wallTimeMs ?? 5 * 60_000,
      cpuTimeMs: null,
      memoryBytes: options.memoryBytes ?? 2 * 1024 * 1024 * 1024,
      diskBytes: 2 * 1024 * 1024 * 1024,
      networkBytes: 128 * 1024 * 1024,
      toolOutputBytes: 64 * 1024 * 1024,
      concurrency: 1,
      retryLimit: 1,
    },
  });

  return { contract, missingExternalInputs };
}
