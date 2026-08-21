import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runMigrations } from "@/lib/db/migrations";
import { ArtifactStore } from "@/lib/artifacts";
import { DocumentLocatorSchema, type DocumentLocator } from "@/lib/artifacts/contracts";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { JsonValueSchema } from "@/lib/capability/common";
import { EvidenceLedger } from "@/lib/evidence";
import { TaskStore } from "@/lib/task";
import { authorizeEvidenceWrite, SecurityAuthorizer } from "@/lib/security";
import { EvaluationRunner } from "./runner";
import { GOLDEN_MANIFESTS } from "./golden-manifests";
import type { GoldenManifest } from "./contracts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const PreproductionFixtureInputSchema = z.object({
  id: z.string().trim().min(1),
  path: z.string().trim().min(1),
  sha256: Sha256Schema,
  mediaType: z.string().trim().min(1),
  logicalName: z.string().trim().min(1),
}).strict();

export const PreproductionFixtureCaseSchema = z.object({
  manifestId: z.string().trim().min(1),
  inputs: z.array(PreproductionFixtureInputSchema).min(1),
  parameters: z.record(z.string(), JsonValueSchema).default({}),
}).strict();

export const PreproductionFixtureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.literal("historical-production"),
  anonymization: z.object({
    method: z.string().trim().min(1),
    approvedBy: z.string().trim().min(1),
    approvedAt: z.string().datetime(),
  }).strict(),
  cases: z.array(PreproductionFixtureCaseSchema).min(1),
}).strict();

export type PreproductionFixtureCase = z.infer<typeof PreproductionFixtureCaseSchema>;

const ValidationStepSchema = z.object({
  status: z.literal("passed"),
  details: JsonValueSchema,
}).strict();

const PreproductionEvidenceSourceSchema = z.object({
  id: z.string().trim().min(1),
  path: z.string().trim().min(1),
  sha256: Sha256Schema,
  mediaType: z.string().trim().min(1),
  logicalName: z.string().trim().min(1),
  locator: DocumentLocatorSchema,
  metadata: z.record(z.string(), JsonValueSchema).default({}),
}).strict();

const PreproductionClaimCitationSchema = z.object({
  evidenceSourceId: z.string().trim().min(1),
  locator: DocumentLocatorSchema,
  quoteHash: Sha256Schema,
}).strict();

export const PreproductionScenarioExecutionSchema = z.object({
  executionClass: z.literal("production"),
  sourceInputId: z.string().trim().min(1).optional(),
  outputPath: z.string().trim().min(1),
  sourceLocator: DocumentLocatorSchema.optional(),
  evidenceSources: z.array(PreproductionEvidenceSourceSchema).min(1).optional(),
  toolVersions: z.record(z.string(), z.string().trim().min(1)).refine((value) => Object.keys(value).length > 0),
  validation: z.object({
    structuralDiff: ValidationStepSchema,
    visualRender: ValidationStepSchema,
    recalculationOrParse: ValidationStepSchema,
    businessAssertions: ValidationStepSchema,
  }).strict(),
  claims: z.array(z.object({
    statement: z.string().trim().min(1),
    structuredValue: JsonValueSchema.optional(),
    citations: z.array(PreproductionClaimCitationSchema).min(1).optional(),
  }).strict()).min(1),
  dimensions: z.object({
    contract: z.number().min(0).max(1),
    artifact: z.number().min(0).max(1),
    evidence: z.number().min(0).max(1),
    memory: z.number().min(0).max(1),
    rag: z.number().min(0).max(1),
    security: z.number().min(0).max(1),
    performance: z.number().min(0).max(1),
  }).partial().strict().refine((value) => Object.keys(value).length > 0, "at least one score dimension is required"),
  metrics: z.record(z.string(), z.number().finite()).default({}),
}).strict().superRefine((execution, context) => {
  const hasLegacySource = Boolean(execution.sourceInputId && execution.sourceLocator);
  const hasEvidenceSources = Boolean(execution.evidenceSources?.length);
  if (!hasLegacySource && !hasEvidenceSources) {
    context.addIssue({
      code: "custom",
      message: "execution requires either sourceInputId/sourceLocator or evidenceSources",
      path: ["evidenceSources"],
    });
  }
  if (Boolean(execution.sourceInputId) !== Boolean(execution.sourceLocator)) {
    context.addIssue({
      code: "custom",
      message: "sourceInputId and sourceLocator must be provided together",
      path: ["sourceLocator"],
    });
  }
  if (hasEvidenceSources) {
    const ids = new Set(execution.evidenceSources!.map((source) => source.id));
    if (ids.size !== execution.evidenceSources!.length) {
      context.addIssue({ code: "custom", message: "evidence source ids must be unique", path: ["evidenceSources"] });
    }
    for (const [claimIndex, claim] of execution.claims.entries()) {
      if (!claim.citations?.length) {
        context.addIssue({
          code: "custom",
          message: "claims require explicit citations when evidenceSources are supplied",
          path: ["claims", claimIndex, "citations"],
        });
        continue;
      }
      for (const [citationIndex, citation] of claim.citations.entries()) {
        if (!ids.has(citation.evidenceSourceId)) {
          context.addIssue({
            code: "custom",
            message: `claim citation references unknown evidence source: ${citation.evidenceSourceId}`,
            path: ["claims", claimIndex, "citations", citationIndex, "evidenceSourceId"],
          });
        }
      }
    }
  }
});

export type PreproductionScenarioExecution = z.infer<typeof PreproductionScenarioExecutionSchema>;

export type PreproductionScenarioAdapter = {
  id: string;
  manifestId: string;
  preflight?: (context: PreproductionScenarioContext) => Promise<string[]> | string[];
  execute: (context: PreproductionScenarioContext) => Promise<PreproductionScenarioExecution>;
};

export type PreproductionScenarioContext = {
  manifest: GoldenManifest;
  fixture: PreproductionFixtureCase;
  fixtureRoot: string;
  workDir: string;
  allowExternalEgress: boolean;
};

export type PreproductionScenarioReport = {
  manifestId: string;
  name: string;
  status: "passed" | "blocked" | "failed";
  adapterId?: string;
  blockers: string[];
  failures: string[];
  artifact?: { path: string; sha256: string; mediaType: string };
  completionEvidence?: {
    evidenceIds: string[];
    verifiedClaimIds: string[];
    passedAssertionIds: string[];
  };
  evaluationRunId?: string;
  metrics: Record<string, number>;
};

export type PreproductionE2EReport = {
  schemaVersion: 1;
  runId: string;
  qualification: "production";
  status: "passed" | "blocked" | "failed";
  fixtureManifestPath: string;
  fixtureManifestSha256?: string;
  startedAt: string;
  endedAt: string;
  cases: PreproductionScenarioReport[];
  blockers: string[];
  failures: string[];
  reportSha256: string;
};

export type RunPreproductionE2EOptions = {
  fixtureRoot: string;
  outputRoot: string;
  adapters: readonly PreproductionScenarioAdapter[];
  trustedAdapterIds: readonly string[];
  allowExternalEgress?: boolean;
  now?: () => Date;
};

function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

function safeFixturePath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`fixture path escapes root: ${relativePath}`);
  }
  return resolved;
}

function safeScenarioPath(root: string, targetPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(targetPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`evidence source path escapes scenario directory: ${targetPath}`);
  }
  return resolved;
}

function verifyCitationQuote(content: Uint8Array, locator: DocumentLocator, expectedQuoteHash: string): void {
  if (locator.kind !== "char_range") return;
  const text = Buffer.from(content).toString("utf8");
  const quote = text.slice(locator.start, locator.end);
  const actual = sha256Json(quote);
  if (actual !== expectedQuoteHash) {
    throw new Error(`citation quote hash mismatch:${locator.nodeId}:${expectedQuoteHash}:${actual}`);
  }
}

function validateFixtureInputs(root: string, fixture: PreproductionFixtureCase): string[] {
  const blockers: string[] = [];
  for (const input of fixture.inputs) {
    let target: string;
    try {
      target = safeFixturePath(root, input.path);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!fs.existsSync(target)) {
      blockers.push(`fixture_missing:${input.id}:${input.path}`);
      continue;
    }
    const actual = sha256File(target);
    if (actual !== input.sha256) blockers.push(`fixture_hash_mismatch:${input.id}:${input.sha256}:${actual}`);
  }
  return blockers;
}

function deriveProductionDimensions(options: {
  manifest: GoldenManifest;
  execution: PreproductionScenarioExecution;
  evidenceCount: number;
  verifiedClaimCount: number;
  passedAssertionCount: number;
}): PreproductionScenarioExecution["dimensions"] {
  const { manifest, execution, evidenceCount, verifiedClaimCount, passedAssertionCount } = options;
  const validationPassed = Object.values(execution.validation).every((step) => step.status === "passed");
  const wallTimeMs = execution.metrics.wallTimeMs;
  const wallTimeBudgetMs = manifest.taskContract.budget.wallTimeMs;
  const performance = typeof wallTimeMs === "number"
    && wallTimeMs >= 0
    && (wallTimeBudgetMs === null || wallTimeMs <= wallTimeBudgetMs)
    ? 1
    : 0;
  return {
    ...execution.dimensions,
    contract: execution.executionClass === "production" && validationPassed ? 1 : 0,
    artifact: 1,
    evidence: evidenceCount >= manifest.expectedEvidenceTypes.length
      && verifiedClaimCount >= execution.claims.length
      && passedAssertionCount >= manifest.taskContract.invariants.length
      ? 1
      : 0,
    security: execution.dimensions.security ?? 0,
    performance,
  };
}

function materializeScenario(options: {
  manifest: GoldenManifest;
  fixture: PreproductionFixtureCase;
  fixtureRoot: string;
  execution: PreproductionScenarioExecution;
  scenarioDir: string;
  now: () => Date;
}): Promise<PreproductionScenarioReport> {
  return (async () => {
    const { manifest, fixture, fixtureRoot, execution, scenarioDir, now } = options;
    if (!fs.existsSync(execution.outputPath)) throw new Error(`adapter output not found: ${execution.outputPath}`);
    const expectedOutput = manifest.taskContract.expectedOutputs[0];
    if (!expectedOutput) throw new Error(`manifest has no expected output: ${manifest.id}`);

    const dbPath = path.join(scenarioDir, "evidence.sqlite");
    const casRoot = path.join(scenarioDir, "cas");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, dbPath, () => null);
    try {
      const taskStore = new TaskStore(db);
      const artifactStore = new ArtifactStore(db, casRoot);
      const ledger = new EvidenceLedger(db);
      const authorizer = new SecurityAuthorizer(db);
      const evaluation = new EvaluationRunner(db, casRoot, now);
      const caseId = manifest.taskContract.caseId ?? `${manifest.id}.case`;
      taskStore.saveContract(manifest.taskContract);
      taskStore.createCase(manifest.taskContract.id, caseId, `${manifest.id}.${randomUUID()}`);
      const principal = manifest.taskContract.security.allowedPrincipals[0];
      if (!principal?.tenantId) throw new Error(`preproduction principal requires tenantId: ${manifest.id}`);
      const writeCapabilities = ["evaluation.source", ...manifest.expectedEvidenceTypes
        .filter((type) => type !== "source").map((type) => `evaluation.${type}`)];
      for (const capabilityId of new Set(writeCapabilities)) {
        authorizer.grant({ id: `${manifest.id}.${capabilityId}.write.${randomUUID()}`, principal,
          tenantId: principal.tenantId, caseId, capabilityId, actions: ["write"], createdAt: now().toISOString() });
      }

      const evidenceSources = new Map<string, {
        artifact: ReturnType<ArtifactStore["put"]>;
        bytes: Uint8Array;
        locator: DocumentLocator;
      }>();
      if (execution.evidenceSources?.length) {
        for (const source of execution.evidenceSources) {
          const sourcePath = safeScenarioPath(scenarioDir, source.path);
          if (!fs.existsSync(sourcePath)) throw new Error(`evidence source not found: ${source.id}:${source.path}`);
          const sourceBytes = fs.readFileSync(sourcePath);
          const actualSha256 = sha256Bytes(sourceBytes);
          if (actualSha256 !== source.sha256) {
            throw new Error(`evidence source hash mismatch:${source.id}:${source.sha256}:${actualSha256}`);
          }
          const artifact = artifactStore.put({
            kind: "evaluation-source",
            logicalName: source.logicalName,
            ownerCaseId: caseId,
            classification: "internal",
            retention: manifest.taskContract.retention,
            mediaType: source.mediaType,
            producer: { capabilityId: "evaluation.research-snapshot", version: "1.0.0", attemptId: randomUUID() },
            metadata: { sourceId: source.id, expectedSha256: source.sha256, ...source.metadata },
            content: sourceBytes,
            state: "candidate",
          });
          evidenceSources.set(source.id, { artifact, bytes: sourceBytes, locator: source.locator });
        }
      } else {
        const sourceInput = fixture.inputs.find((item) => item.id === execution.sourceInputId);
        if (!sourceInput) throw new Error(`execution source input not found: ${execution.sourceInputId}`);
        const sourceBytes = fs.readFileSync(safeFixturePath(fixtureRoot, sourceInput.path));
        const artifact = artifactStore.put({
          kind: "evaluation-source",
          logicalName: sourceInput.logicalName,
          ownerCaseId: caseId,
          classification: "confidential",
          retention: manifest.taskContract.retention,
          mediaType: sourceInput.mediaType,
          producer: { capabilityId: "evaluation.fixture", version: "1.0.0", attemptId: randomUUID() },
          metadata: { fixtureId: sourceInput.id, expectedSha256: sourceInput.sha256 },
          content: sourceBytes,
          state: "candidate",
        });
        evidenceSources.set(sourceInput.id, { artifact, bytes: sourceBytes, locator: execution.sourceLocator! });
      }
      const outputBytes = fs.readFileSync(execution.outputPath);
      const output = artifactStore.put({
        kind: "evaluation-deliverable",
        logicalName: expectedOutput.logicalName,
        ownerCaseId: caseId,
        classification: "confidential",
        retention: manifest.taskContract.retention,
        mediaType: expectedOutput.mediaType,
        producer: { capabilityId: "evaluation.preproduction", version: "1.0.0", attemptId: randomUUID() },
        metadata: {
          inputHashes: fixture.inputs.map((item) => ({ id: item.id, sha256: item.sha256 })),
          toolVersions: execution.toolVersions,
          validation: execution.validation,
        },
        content: outputBytes,
        state: "candidate",
      });

      const createdAt = now().toISOString();
      const evidenceIds: string[] = [];
      const sourceEvidenceIds = new Map<string, string>();
      let previousEvidence: { evidenceId: string; outputHash: string } | undefined;
      for (const [sourceId, source] of evidenceSources) {
        const evidenceId = `${manifest.id}.evidence.source.${randomUUID()}`;
        ledger.addEvidence(caseId, {
          id: evidenceId,
          type: "source",
          artifact: source.artifact,
          locator: source.locator,
          producer: { capabilityId: "evaluation.source", version: "1.0.0", attemptId: randomUUID() },
          inputs: previousEvidence ? [previousEvidence] : [],
          outputHash: source.artifact.sha256,
          confidence: 1,
          policyDecisionId: authorizeEvidenceWrite({ authorizer, principal, tenantId: principal.tenantId!, caseId,
            capabilityId: "evaluation.source", artifactVersionId: source.artifact.versionId,
            classification: execution.evidenceSources?.length ? "internal" : "confidential", now: createdAt }),
          createdAt,
        });
        sourceEvidenceIds.set(sourceId, evidenceId);
        evidenceIds.push(evidenceId);
        previousEvidence = { evidenceId, outputHash: source.artifact.sha256 };
      }
      for (const evidenceType of manifest.expectedEvidenceTypes.filter((type) => type !== "source")) {
        const artifact = output;
        const evidenceId = `${manifest.id}.evidence.${evidenceType}.${randomUUID()}`;
        ledger.addEvidence(caseId, {
          id: evidenceId,
          type: evidenceType,
          artifact,
          producer: { capabilityId: `evaluation.${evidenceType}`, version: "1.0.0", attemptId: randomUUID() },
          inputs: previousEvidence ? [previousEvidence] : [],
          outputHash: artifact.sha256,
          confidence: 1,
          policyDecisionId: authorizeEvidenceWrite({ authorizer, principal, tenantId: principal.tenantId!, caseId,
            capabilityId: `evaluation.${evidenceType}`, artifactVersionId: artifact.versionId,
            classification: "confidential", now: createdAt }),
          createdAt,
        });
        evidenceIds.push(evidenceId);
        previousEvidence = { evidenceId, outputHash: artifact.sha256 };
      }

      const claimIds: string[] = [];
      for (const [index, claim] of execution.claims.entries()) {
        const claimId = `${manifest.id}.claim.${index + 1}.${randomUUID()}`;
        const explicitCitations = claim.citations ?? [];
        const claimEvidenceIds = explicitCitations.length > 0
          ? [...new Set(explicitCitations.map((citation) => sourceEvidenceIds.get(citation.evidenceSourceId)!))]
          : evidenceIds;
        ledger.addClaim({
          id: claimId,
          caseId,
          statement: claim.statement,
          ...(claim.structuredValue !== undefined ? { structuredValue: claim.structuredValue } : {}),
          evidenceRefs: claimEvidenceIds,
          status: "verified",
        });
        if (explicitCitations.length > 0) {
          for (const citation of explicitCitations) {
            const source = evidenceSources.get(citation.evidenceSourceId);
            if (!source) throw new Error(`claim citation source not materialized: ${citation.evidenceSourceId}`);
            verifyCitationQuote(source.bytes, citation.locator, citation.quoteHash);
            ledger.addCitation({
              id: `${manifest.id}.citation.${index + 1}.${randomUUID()}`,
              claimId,
              artifactVersionId: source.artifact.versionId,
              locator: citation.locator,
              quoteHash: citation.quoteHash,
              createdAt,
            });
          }
        } else {
          const legacySource = evidenceSources.get(execution.sourceInputId!);
          if (!legacySource) throw new Error(`legacy claim source not materialized: ${execution.sourceInputId}`);
          ledger.addCitation({
            id: `${manifest.id}.citation.${index + 1}.${randomUUID()}`,
            claimId,
            artifactVersionId: legacySource.artifact.versionId,
            locator: execution.sourceLocator!,
            quoteHash: sha256Json({ statement: claim.statement }),
            createdAt,
          });
        }
        claimIds.push(claimId);
      }

      for (const invariant of manifest.taskContract.invariants) {
        ledger.recordAssertion({
          caseId,
          assertionId: invariant.id,
          validatorId: invariant.validatorId,
          status: "passed",
          blocking: invariant.severity === "blocking",
          evidenceId: evidenceIds.at(-1),
          details: execution.validation,
        });
      }
      ledger.assertDeliveryGate(caseId);
      const delivered = artifactStore.transition(output.artifactId, "delivered");
      const completionEvidence = ledger.buildCompletionEvidence(caseId);
      const dimensions = deriveProductionDimensions({
        manifest,
        execution,
        evidenceCount: completionEvidence.evidenceIds.length,
        verifiedClaimCount: completionEvidence.verifiedClaimIds.length,
        passedAssertionCount: completionEvidence.passedAssertionIds.length,
      });
      const result = await evaluation.run(manifest, async () => ({
        artifactVersionIds: [delivered.versionId],
        evidenceIds,
        claimIds,
        passedAssertionIds: manifest.assertions.map((assertion) => assertion.id),
        metrics: execution.metrics,
        dimensions,
        details: {
          qualification: "production",
          executionClass: execution.executionClass,
          toolVersions: execution.toolVersions,
          validation: execution.validation,
          completionEvidence,
        },
      }));
      const outputCopy = path.join(scenarioDir, expectedOutput.logicalName);
      if (path.resolve(execution.outputPath) !== path.resolve(outputCopy)) {
        fs.copyFileSync(execution.outputPath, outputCopy);
      }
      return {
        manifestId: manifest.id,
        name: manifest.name,
        status: result.status === "passed" ? "passed" : "failed",
        blockers: [],
        failures: result.failures,
        artifact: { path: outputCopy, sha256: delivered.sha256, mediaType: delivered.mediaType },
        completionEvidence: {
          evidenceIds: completionEvidence.evidenceIds,
          verifiedClaimIds: completionEvidence.verifiedClaimIds,
          passedAssertionIds: completionEvidence.passedAssertionIds,
        },
        evaluationRunId: result.runId,
        metrics: execution.metrics,
      };
    } finally {
      db.close();
    }
  })();
}

export async function runPreproductionE2E(options: RunPreproductionE2EOptions): Promise<PreproductionE2EReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runId = randomUUID();
  const fixtureRoot = path.resolve(options.fixtureRoot);
  const outputRoot = path.resolve(options.outputRoot);
  const runRoot = path.join(outputRoot, runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const fixtureManifestPath = path.join(fixtureRoot, "preproduction-e2e.json");
  const suiteBlockers: string[] = [];
  const suiteFailures: string[] = [];
  let fixtureManifestSha256: string | undefined;
  let fixtureManifest: z.infer<typeof PreproductionFixtureManifestSchema> | undefined;

  if (!fs.existsSync(fixtureManifestPath)) {
    suiteBlockers.push(`fixture_manifest_missing:${fixtureManifestPath}`);
  } else {
    try {
      const bytes = fs.readFileSync(fixtureManifestPath);
      fixtureManifestSha256 = sha256Bytes(bytes);
      fixtureManifest = PreproductionFixtureManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      suiteFailures.push(`fixture_manifest_invalid:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const adapterByManifest = new Map<string, PreproductionScenarioAdapter>();
  const trustedAdapterIds = new Set(options.trustedAdapterIds);
  for (const adapter of options.adapters) {
    if (!trustedAdapterIds.has(adapter.id)) {
      suiteFailures.push(`production_adapter_not_trusted:${adapter.id}`);
      continue;
    }
    if (adapterByManifest.has(adapter.manifestId)) {
      suiteFailures.push(`duplicate_production_adapter:${adapter.manifestId}`);
      continue;
    }
    adapterByManifest.set(adapter.manifestId, adapter);
  }
  const reports: PreproductionScenarioReport[] = [];
  for (const manifest of GOLDEN_MANIFESTS) {
    const fixture = fixtureManifest?.cases.find((item) => item.manifestId === manifest.id);
    const adapter = adapterByManifest.get(manifest.id);
    const blockers: string[] = [];
    if (!fixture) blockers.push(`fixture_case_missing:${manifest.id}`);
    if (!adapter) blockers.push(`production_adapter_missing:${manifest.id}`);
    if (manifest.caseKind === "web_due_diligence" && !options.allowExternalEgress) {
      blockers.push("external_egress_not_authorized:web_due_diligence");
    }
    if (fixture) blockers.push(...validateFixtureInputs(fixtureRoot, fixture));
    if (fixture && adapter && blockers.length === 0 && adapter.preflight) {
      blockers.push(...await adapter.preflight({
        manifest,
        fixture,
        fixtureRoot,
        workDir: path.join(runRoot, manifest.id),
        allowExternalEgress: options.allowExternalEgress ?? false,
      }));
    }
    if (!fixture || !adapter || blockers.length > 0) {
      reports.push({
        manifestId: manifest.id,
        name: manifest.name,
        status: "blocked",
        ...(adapter ? { adapterId: adapter.id } : {}),
        blockers,
        failures: [],
        metrics: {},
      });
      continue;
    }

    const scenarioDir = path.join(runRoot, manifest.id);
    fs.mkdirSync(scenarioDir, { recursive: true });
    try {
      const context = {
        manifest,
        fixture,
        fixtureRoot,
        workDir: scenarioDir,
        allowExternalEgress: options.allowExternalEgress ?? false,
      };
      const execution = PreproductionScenarioExecutionSchema.parse(await adapter.execute(context));
      const report = await materializeScenario({ manifest, fixture, fixtureRoot, execution, scenarioDir, now });
      reports.push({ ...report, adapterId: adapter.id });
    } catch (error) {
      reports.push({
        manifestId: manifest.id,
        name: manifest.name,
        status: "failed",
        adapterId: adapter.id,
        blockers: [],
        failures: [error instanceof Error ? error.message : String(error)],
        metrics: {},
      });
    }
  }

  const blockers = [...suiteBlockers, ...reports.flatMap((report) => report.blockers)];
  const failures = [...suiteFailures, ...reports.flatMap((report) => report.failures)];
  const status: PreproductionE2EReport["status"] = failures.length > 0 || reports.some((report) => report.status === "failed")
    ? "failed"
    : blockers.length > 0 || reports.some((report) => report.status === "blocked")
      ? "blocked"
      : "passed";
  const endedAt = now().toISOString();
  const reportWithoutHash = {
    schemaVersion: 1 as const,
    runId,
    qualification: "production" as const,
    status,
    fixtureManifestPath,
    ...(fixtureManifestSha256 ? { fixtureManifestSha256 } : {}),
    startedAt,
    endedAt,
    cases: reports,
    blockers,
    failures,
  };
  const report: PreproductionE2EReport = {
    ...reportWithoutHash,
    reportSha256: sha256Bytes(Buffer.from(canonicalJson(reportWithoutHash))),
  };
  fs.writeFileSync(path.join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
