import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DocumentLocatorSchema } from "@/lib/artifacts/contracts";
import { BusinessRuleRegistry } from "@/lib/business-rules/engine";
import { registerFinanceRulePack } from "@/lib/business-rules/finance-pack";
import { runMigrations } from "@/lib/db/migrations";
import { insertKnowledgeDocument } from "@/lib/db/sqlite";
import { validateDocxFile } from "@/lib/deliverable/validators/docx";
import { generateDocx, probeDocxPdfRenderer, renderDocxToPdf } from "@/lib/document-generation";
import { parseDocumentFile } from "@/lib/document-ir/adapters";
import { GovernedMemoryStore } from "@/lib/memory-v2/store";
import { createProductionRetrievalService } from "@/lib/retrieval/production";
import {
  spreadsheetCompareAllowedCells,
  spreadsheetInspectCells,
  spreadsheetPatchWorkbook,
  spreadsheetProbe,
  spreadsheetRecalc,
  spreadsheetRender,
  type WorkbookEdit,
} from "@/lib/runtime/spreadsheet-runtime";
import type {
  PreproductionScenarioAdapter,
  PreproductionScenarioContext,
  PreproductionScenarioExecution,
} from "./preproduction-e2e";
import { createWebDueDiligencePreproductionAdapter } from "./web-due-diligence-adapter";

const CellValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const WorkbookEditSchema = z.object({
  sheet: z.string().trim().min(1),
  cell: z.string().regex(/^\$?[A-Z]{1,3}\$?\d+$/i),
  value: CellValueSchema.optional(),
  formula: z.string().trim().min(1).optional(),
  clear: z.boolean().optional(),
  createSheet: z.boolean().optional(),
}).strict().refine((edit) => Number(edit.value !== undefined) + Number(edit.formula !== undefined) + Number(edit.clear === true) === 1, {
  message: "each edit must specify exactly one of value, formula, or clear",
});

const ConsolidationParametersSchema = z.object({
  sourceInputId: z.string().trim().min(1),
  outputName: z.string().trim().min(1).regex(/\.xlsx$/i).default("集团合并底稿.xlsx"),
  edits: z.array(WorkbookEditSchema).min(1),
  allowedChanges: z.object({
    sheet: z.string().trim().min(1),
    columns: z.array(z.string().regex(/^[A-Z]{1,3}$/i)).min(1),
  }).strict(),
  expectedCells: z.record(z.string().regex(/^.+!\$?[A-Z]{1,3}\$?\d+$/i), CellValueSchema).refine(
    (values) => Object.keys(values).length > 0,
    "at least one business assertion is required",
  ),
  numericTolerance: z.number().finite().nonnegative().default(0.01),
  sourceLocator: DocumentLocatorSchema,
}).strict();

type ConsolidationParameters = z.infer<typeof ConsolidationParametersSchema>;

const RuleLocatorsSchema = z.array(z.string().trim().min(1).max(500)).default([]);
const TaxPayrollRuleSchema = z.discriminatedUnion("ruleId", [
  z.object({
    ruleId: z.literal("tax-rate-basic"),
    version: z.literal("2026.1"),
    facts: z.object({ taxableBase: z.number().finite(), applicableRate: z.number().finite().min(0).max(1), recordedTax: z.number().finite(), locators: RuleLocatorsSchema }).strict(),
    expectedStatus: z.enum(["passed", "failed", "not_applicable", "unverifiable"]),
    statement: z.string().trim().min(1).max(1_000),
  }).strict(),
  z.object({
    ruleId: z.literal("payroll-basic"),
    version: z.literal("2026.1"),
    facts: z.object({ grossPay: z.number().finite().nonnegative(), deductions: z.number().finite().nonnegative(), recordedNetPay: z.number().finite(), locators: RuleLocatorsSchema }).strict(),
    expectedStatus: z.enum(["passed", "failed", "not_applicable", "unverifiable"]),
    statement: z.string().trim().min(1).max(1_000),
  }).strict(),
]);

const TaxPayrollParametersSchema = z.object({
  sourceInputId: z.string().trim().min(1),
  policyInputId: z.string().trim().min(1),
  outputName: z.string().trim().min(1).regex(/\.docx$/i).default("薪税申报复核.docx"),
  asOf: z.iso.date(),
  effectivePeriod: z.object({
    start: z.iso.date(),
    end: z.iso.date(),
    label: z.string().trim().min(1).max(200).optional(),
  }).strict().refine((period) => period.start <= period.end, {
    message: "effectivePeriod.start must be before or equal to end",
    path: ["end"],
  }),
  entityRef: z.string().trim().min(1).max(200),
  sourceLocator: DocumentLocatorSchema,
  sourceQuote: z.string().trim().min(1).max(2_000),
  policyQuery: z.string().trim().min(1).max(10_000),
  expectedPolicyQuote: z.string().trim().min(1).max(2_000),
  ruleEvaluations: z.array(TaxPayrollRuleSchema).min(2).refine(
    (rules) => new Set(rules.map((rule) => rule.ruleId)).size === rules.length,
    "ruleEvaluations must not contain duplicate rule ids",
  ),
  memory: z.object({
    summary: z.string().trim().min(1).max(2_000),
    conflictKey: z.string().trim().min(1).max(200),
  }).strict(),
}).strict();

type TaxPayrollParameters = z.infer<typeof TaxPayrollParametersSchema>;

const MultiDocumentClaimSchema = z.object({
  id: z.string().trim().min(1).max(200),
  inputId: z.string().trim().min(1),
  query: z.string().trim().min(1).max(10_000),
  statement: z.string().trim().min(1).max(2_000),
  expectedQuote: z.string().trim().min(1).max(2_000),
  sourceLocator: DocumentLocatorSchema,
}).strict();

const MultiDocumentRagParametersSchema = z.object({
  sourceInputIds: z.array(z.string().trim().min(1)).min(2).refine(
    (ids) => new Set(ids).size === ids.length,
    "sourceInputIds must not contain duplicates",
  ),
  outputName: z.string().trim().min(1).regex(/\.pdf$/i).default("多文档检索报告.pdf"),
  asOf: z.iso.date(),
  reportTitle: z.string().trim().min(1).max(300).default("多文档可追溯问答"),
  claims: z.array(MultiDocumentClaimSchema).min(2).refine(
    (claims) => new Set(claims.map((claim) => claim.id)).size === claims.length,
    "claims must not contain duplicate ids",
  ),
  memory: z.object({
    entityRef: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2_000),
    conflictKey: z.string().trim().min(1).max(200),
    effectivePeriod: z.object({
      start: z.iso.date(),
      end: z.iso.date(),
      label: z.string().trim().min(1).max(200).optional(),
    }).strict().refine((period) => period.start <= period.end, {
      message: "memory.effectivePeriod.start must be before or equal to end",
      path: ["end"],
    }),
  }).strict(),
}).strict().superRefine((parameters, context) => {
  const sourceIds = new Set(parameters.sourceInputIds);
  for (const [index, claim] of parameters.claims.entries()) {
    if (!sourceIds.has(claim.inputId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims", index, "inputId"],
        message: `claim inputId is not declared in sourceInputIds: ${claim.inputId}`,
      });
    }
  }
});

type MultiDocumentRagParameters = z.infer<typeof MultiDocumentRagParametersSchema>;

function resolveFixtureInput(context: PreproductionScenarioContext, inputId: string): string {
  const input = context.fixture.inputs.find((candidate) => candidate.id === inputId);
  if (!input) throw new Error(`fixture input not found: ${inputId}`);
  const root = path.resolve(context.fixtureRoot);
  const target = path.resolve(root, input.path);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`fixture input escapes root: ${input.path}`);
  }
  return target;
}

function requireOk<T>(
  stage: string,
  result: { ok: boolean; data?: T; errorCode?: string; detail?: string },
): T {
  if (!result.ok || result.data === undefined) {
    throw new Error(`${stage}:${result.errorCode ?? "failed"}:${result.detail ?? "missing result"}`);
  }
  return result.data;
}

function valuesEqual(actual: string | number | boolean | null, expected: string | number | boolean | null, tolerance: number): boolean {
  if (typeof actual === "number" && typeof expected === "number") return Math.abs(actual - expected) <= tolerance;
  return actual === expected;
}

function parseParameters(context: PreproductionScenarioContext): ConsolidationParameters {
  return ConsolidationParametersSchema.parse(context.fixture.parameters);
}

function parseTaxPayrollParameters(context: PreproductionScenarioContext): TaxPayrollParameters {
  return TaxPayrollParametersSchema.parse(context.fixture.parameters);
}

function parseMultiDocumentRagParameters(context: PreproductionScenarioContext): MultiDocumentRagParameters {
  return MultiDocumentRagParametersSchema.parse(context.fixture.parameters);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function documentText(document: Awaited<ReturnType<typeof parseDocumentFile>>): string {
  return document.nodes
    .map((node) => node.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function requireDocumentContent(
  stage: string,
  document: Awaited<ReturnType<typeof parseDocumentFile>>,
  expectedText?: string,
): string {
  if (document.manifest.blocked) {
    throw new Error(`${stage}_preservation_blocked:${document.manifest.blockingReasons.join("|")}`);
  }
  const text = documentText(document);
  if (!text) throw new Error(`${stage}_empty`);
  if (expectedText && !normalizedText(text).includes(normalizedText(expectedText))) {
    throw new Error(`${stage}_expected_text_missing`);
  }
  return text;
}

async function taxPayrollPreflight(context: PreproductionScenarioContext): Promise<string[]> {
  let parameters: TaxPayrollParameters;
  try {
    parameters = parseTaxPayrollParameters(context);
  } catch (error) {
    return [`fixture_parameters_invalid:${error instanceof Error ? error.message : String(error)}`];
  }
  const blockers: string[] = [];
  for (const inputId of [parameters.sourceInputId, parameters.policyInputId]) {
    try {
      const inputPath = resolveFixtureInput(context, inputId);
      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) blockers.push(`fixture_missing:${inputId}`);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  const renderer = probeDocxPdfRenderer();
  if (!renderer.ok) blockers.push(`document_renderer_unavailable:${renderer.detail}`);
  return [...new Set(blockers)];
}

async function executeTaxPayroll(context: PreproductionScenarioContext): Promise<PreproductionScenarioExecution> {
  const started = performance.now();
  const parameters = parseTaxPayrollParameters(context);
  const sourcePath = resolveFixtureInput(context, parameters.sourceInputId);
  const policyPath = resolveFixtureInput(context, parameters.policyInputId);
  const sourceBefore = fs.readFileSync(sourcePath);
  const policyBefore = fs.readFileSync(policyPath);
  const sourceHash = sha256(sourceBefore);
  const policyHash = sha256(policyBefore);
  const sourceInput = context.fixture.inputs.find((input) => input.id === parameters.sourceInputId);
  const policyInput = context.fixture.inputs.find((input) => input.id === parameters.policyInputId);
  if (!sourceInput || !policyInput) throw new Error("tax_payroll_fixture_input_metadata_missing");

  const sourceDocument = await parseDocumentFile(sourcePath);
  const policyDocument = await parseDocumentFile(policyPath);
  const sourceText = requireDocumentContent("tax_payroll_source", sourceDocument, parameters.sourceQuote);
  const policyText = requireDocumentContent("tax_payroll_policy", policyDocument, parameters.expectedPolicyQuote);

  fs.mkdirSync(context.workDir, { recursive: true });
  const databasePath = path.join(context.workDir, "tax-payroll-evidence.sqlite");
  const db = new DatabaseSync(databasePath);
  const principal = { id: "evaluation.service", type: "service" as const, tenantId: "evaluation" };
  try {
    runMigrations(db, databasePath, () => null);
    const policyDocumentId = insertKnowledgeDocument({
      title: policyInput.logicalName,
      file_name: path.basename(policyPath),
      mime_type: policyInput.mediaType,
      category: "tax-policy",
      size_bytes: policyBefore.byteLength,
      chunk_count: 0,
      content_hash: policyHash,
    }, db);
    const retrieval = createProductionRetrievalService({
      db,
      casRoot: path.join(context.workDir, "retrieval-cas"),
      principal,
    });
    const indexed = await retrieval.indexKnowledgeDocument({
      knowledgeDocumentId: policyDocumentId,
      title: policyInput.logicalName,
      fileName: path.basename(policyPath),
      sourceContentHash: policyHash,
      parsedText: policyText,
      category: "tax-policy",
      now: `${parameters.asOf}T12:00:00.000Z`,
    });
    const retrievalResult = await retrieval.search(parameters.policyQuery, 10, `${parameters.asOf}T12:00:00.000Z`);
    const expectedPolicy = normalizedText(parameters.expectedPolicyQuote);
    const policyHit = retrievalResult.hits.find((hit) => normalizedText(hit.citation.quotedText).includes(expectedPolicy));
    if (!policyHit) throw new Error("tax_payroll_policy_citation_missing");
    if (policyHit.citation.artifactVersionId !== indexed.artifactVersionId) {
      throw new Error("tax_payroll_policy_citation_version_mismatch");
    }

    const memoryStore = new GovernedMemoryStore(db);
    const at = `${parameters.asOf}T12:00:00.000Z`;
    const memoryId = `tax-payroll-${sha256(Buffer.from(`${parameters.entityRef}:${parameters.memory.conflictKey}:${parameters.memory.summary}`)).slice(0, 24)}`;
    const candidate = memoryStore.createCandidate({
      record: {
        id: memoryId,
        kind: "semantic",
        scope: {
          tenantId: "evaluation",
          principalId: principal.id,
          caseId: context.manifest.taskContract.caseId,
        },
        entityRefs: [parameters.entityRef],
        effectivePeriod: parameters.effectivePeriod,
        content: { summary: parameters.memory.summary },
        sourceEvidenceRefs: [indexed.artifactVersionId],
        confidence: 1,
        sensitivity: "internal",
        createdAt: at,
        owner: principal,
      },
      conflictKey: parameters.memory.conflictKey,
    });
    const approved = memoryStore.approve({
      memoryId: candidate.id,
      approver: principal,
      reason: "preproduction fixture explicitly approved for governed retrieval verification",
      at,
    });
    const selectedMemory = memoryStore.retrieve({
      principal,
      tenantId: "evaluation",
      caseId: context.manifest.taskContract.caseId,
      entityRefs: [parameters.entityRef],
      effectivePeriod: parameters.effectivePeriod,
      kinds: ["semantic"],
      queryText: parameters.memory.summary,
      maximumSensitivity: "confidential",
      minimumConfidence: 1,
      limit: 10,
      now: at,
    }).find((selection) => selection.memory.id === approved.id);
    if (!selectedMemory || selectedMemory.summary !== parameters.memory.summary) {
      throw new Error("tax_payroll_governed_memory_not_retrieved");
    }
    if (!selectedMemory.evidenceRefs.includes(indexed.artifactVersionId)) {
      throw new Error("tax_payroll_memory_evidence_mismatch");
    }

    const ruleRegistry = new BusinessRuleRegistry();
    registerFinanceRulePack(ruleRegistry);
    const ruleAssertions = parameters.ruleEvaluations.map((rule) => {
      const assertion = ruleRegistry.evaluate(rule.ruleId, rule.version, rule.facts, sourceHash, parameters.asOf);
      if (assertion.status !== rule.expectedStatus) {
        throw new Error(`tax_payroll_rule_status_mismatch:${rule.ruleId}:${rule.expectedStatus}:${assertion.status}`);
      }
      return { expected: rule, assertion };
    });

    const report = {
      schemaVersion: 1 as const,
      title: "薪税申报复核",
      subtitle: parameters.effectivePeriod.label ?? `${parameters.effectivePeriod.start} 至 ${parameters.effectivePeriod.end}`,
      metadata: [
        { label: "实体", value: parameters.entityRef },
        { label: "复核日", value: parameters.asOf },
        { label: "规则版本", value: "2026.1" },
      ],
      sections: [
        {
          id: "source-review",
          heading: "申报材料与口径",
          paragraphs: [parameters.sourceQuote, `已审批记忆：${selectedMemory.summary}`],
          tables: [],
        },
        {
          id: "policy-evidence",
          heading: "政策依据",
          paragraphs: [
            policyHit.citation.quotedText,
            `证据版本：${policyHit.citation.artifactVersionId}；定位：${JSON.stringify(policyHit.citation.locator)}`,
          ],
          tables: [],
        },
        {
          id: "rule-assertions",
          heading: "规则复核",
          paragraphs: [],
          tables: [{
            caption: "薪税规则断言",
            columns: ["规则", "版本", "状态", "结论", "定位"],
            rows: ruleAssertions.map(({ expected, assertion }) => [
              expected.ruleId,
              expected.version,
              assertion.status,
              expected.statement,
              assertion.locators.join("；") || "无",
            ]),
          }],
        },
      ],
      footer: `Finwork 可追溯复核 · 源文件 ${sourceHash.slice(0, 12)} · 政策 ${policyHash.slice(0, 12)}`,
    };
    const generated = await generateDocx({
      report,
      outputRoot: context.workDir,
      outputName: path.basename(parameters.outputName),
    });
    const validated = await validateDocxFile({
      filePath: generated.outputPath,
      fileName: path.basename(generated.outputPath),
      expectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      qualityProfile: "generic",
      expectedSha256: generated.sha256,
    });
    if (validated.status !== "passed") {
      throw new Error(`tax_payroll_docx_validation_failed:${JSON.stringify(validated.errors)}`);
    }
    const generatedDocument = await parseDocumentFile(generated.outputPath, "docx");
    const generatedText = requireDocumentContent("tax_payroll_output", generatedDocument);
    const requiredOutputText = [parameters.sourceQuote, parameters.expectedPolicyQuote, parameters.memory.summary, ...parameters.ruleEvaluations.map((rule) => rule.statement)];
    const missingOutputText = requiredOutputText.filter((text) => !normalizedText(generatedText).includes(normalizedText(text)));
    if (missingOutputText.length > 0) throw new Error(`tax_payroll_output_text_missing:${missingOutputText.join("|")}`);
    const rendered = renderDocxToPdf({
      sourcePath: generated.outputPath,
      outputRoot: path.join(context.workDir, "rendered"),
      outputName: `${path.basename(parameters.outputName, ".docx")}.pdf`,
    });

    if (!sourceBefore.equals(fs.readFileSync(sourcePath))) throw new Error("tax_payroll_mutated_source");
    if (!policyBefore.equals(fs.readFileSync(policyPath))) throw new Error("tax_payroll_mutated_policy");
    const elapsedMs = performance.now() - started;
    return {
      executionClass: "production",
      sourceInputId: parameters.sourceInputId,
      outputPath: generated.outputPath,
      sourceLocator: parameters.sourceLocator,
      toolVersions: {
        documentParser: "finwork.document-ir:v1",
        retrieval: "bm25-index-v1",
        memory: "governed-memory-v2",
        businessRules: "finance-rule-pack:2026.1",
        documentGenerator: generated.producer,
        documentValidator: validated.validatorId,
        visualRender: `${rendered.provider}:${rendered.version ?? "unknown"}`,
      },
      validation: {
        structuralDiff: {
          status: "passed",
          details: { sourceUnchanged: true, policyUnchanged: true, outputSha256: generated.sha256 },
        },
        visualRender: {
          status: "passed",
          details: { pdf: path.basename(rendered.outputPath), sha256: rendered.sha256, bytes: rendered.bytes, durationMs: rendered.durationMs },
        },
        recalculationOrParse: {
          status: "passed",
          details: { sourceNodes: sourceDocument.nodes.length, policyNodes: policyDocument.nodes.length, outputNodes: generatedDocument.nodes.length, validator: validated.validatorId },
        },
        businessAssertions: {
          status: "passed",
          details: {
            policyCitation: policyHit.citation,
            approvedMemoryId: approved.id,
            ruleAssertions: ruleAssertions.map(({ assertion }) => assertion),
          },
        },
      },
      claims: [
        ...ruleAssertions.map(({ expected, assertion }) => ({
          statement: expected.statement,
          structuredValue: { ruleId: expected.ruleId, version: expected.version, status: assertion.status },
        })),
        {
          statement: `政策依据已定位到不可变版本 ${policyHit.citation.artifactVersionId}。`,
          structuredValue: { quotedText: policyHit.citation.quotedText, locator: policyHit.citation.locator },
        },
      ],
      dimensions: {
        memory: 1,
        rag: 1,
        performance: context.manifest.taskContract.budget.wallTimeMs === null
          || elapsedMs <= context.manifest.taskContract.budget.wallTimeMs ? 1 : 0,
      },
      metrics: {
        wallTimeMs: elapsedMs,
        sourceNodeCount: sourceDocument.nodes.length,
        policyNodeCount: policyDocument.nodes.length,
        retrievalHitCount: retrievalResult.hits.length,
        retrievedMemoryCount: 1,
        ruleAssertionCount: ruleAssertions.length,
        outputBytes: generated.bytes,
        renderedBytes: rendered.bytes,
      },
    };
  } finally {
    db.close();
  }
}

async function multiDocumentRagPreflight(context: PreproductionScenarioContext): Promise<string[]> {
  let parameters: MultiDocumentRagParameters;
  try {
    parameters = parseMultiDocumentRagParameters(context);
  } catch (error) {
    return [`fixture_parameters_invalid:${error instanceof Error ? error.message : String(error)}`];
  }
  const blockers: string[] = [];
  for (const inputId of parameters.sourceInputIds) {
    try {
      const inputPath = resolveFixtureInput(context, inputId);
      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) blockers.push(`fixture_missing:${inputId}`);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  const renderer = probeDocxPdfRenderer();
  if (!renderer.ok) blockers.push(`document_renderer_unavailable:${renderer.detail}`);
  return [...new Set(blockers)];
}

async function executeMultiDocumentRag(context: PreproductionScenarioContext): Promise<PreproductionScenarioExecution> {
  const started = performance.now();
  const parameters = parseMultiDocumentRagParameters(context);
  const sourceRecords = parameters.sourceInputIds.map((inputId) => {
    const fixtureInput = context.fixture.inputs.find((input) => input.id === inputId);
    if (!fixtureInput) throw new Error(`multi_document_fixture_input_metadata_missing:${inputId}`);
    const inputPath = resolveFixtureInput(context, inputId);
    const bytes = fs.readFileSync(inputPath);
    return {
      inputId,
      fixtureInput,
      inputPath,
      bytes,
      sha256: sha256(bytes),
    };
  });

  const parsedDocuments = new Map<string, Awaited<ReturnType<typeof parseDocumentFile>>>();
  const parsedTexts = new Map<string, string>();
  for (const source of sourceRecords) {
    const parsed = await parseDocumentFile(source.inputPath);
    const claims = parameters.claims.filter((claim) => claim.inputId === source.inputId);
    const text = requireDocumentContent(`multi_document_source_${source.inputId}`, parsed);
    for (const claim of claims) {
      if (!normalizedText(text).includes(normalizedText(claim.expectedQuote))) {
        throw new Error(`multi_document_expected_quote_missing:${claim.id}:${source.inputId}`);
      }
    }
    parsedDocuments.set(source.inputId, parsed);
    parsedTexts.set(source.inputId, text);
  }

  fs.mkdirSync(context.workDir, { recursive: true });
  const databasePath = path.join(context.workDir, "multi-document-rag-evidence.sqlite");
  const db = new DatabaseSync(databasePath);
  const principal = { id: "evaluation.service", type: "service" as const, tenantId: "evaluation" };
  try {
    runMigrations(db, databasePath, () => null);
    const retrieval = createProductionRetrievalService({
      db,
      casRoot: path.join(context.workDir, "retrieval-cas"),
      principal,
    });
    const indexedByInputId = new Map<string, Awaited<ReturnType<typeof retrieval.indexKnowledgeDocument>>>();
    for (const source of sourceRecords) {
      const text = parsedTexts.get(source.inputId);
      if (!text) throw new Error(`multi_document_parsed_text_missing:${source.inputId}`);
      const documentId = insertKnowledgeDocument({
        title: source.fixtureInput.logicalName,
        file_name: path.basename(source.inputPath),
        mime_type: source.fixtureInput.mediaType,
        category: "multi-document-evidence",
        size_bytes: source.bytes.byteLength,
        chunk_count: 0,
        content_hash: source.sha256,
      }, db);
      const indexed = await retrieval.indexKnowledgeDocument({
        knowledgeDocumentId: documentId,
        title: source.fixtureInput.logicalName,
        fileName: path.basename(source.inputPath),
        sourceContentHash: source.sha256,
        parsedText: text,
        category: "multi-document-evidence",
        now: `${parameters.asOf}T12:00:00.000Z`,
      });
      indexedByInputId.set(source.inputId, indexed);
    }

    const verifiedClaims: Array<{
      claim: MultiDocumentRagParameters["claims"][number];
      citation: Awaited<ReturnType<typeof retrieval.search>>["hits"][number]["citation"];
      rank: number;
      score: number;
    }> = [];
    let retrievalHitCount = 0;
    for (const claim of parameters.claims) {
      const indexed = indexedByInputId.get(claim.inputId);
      if (!indexed) throw new Error(`multi_document_index_missing:${claim.inputId}`);
      const searchResult = await retrieval.search(claim.query, 20, `${parameters.asOf}T12:00:00.000Z`);
      retrievalHitCount += searchResult.hits.length;
      const expectedQuote = normalizedText(claim.expectedQuote);
      const hitIndex = searchResult.hits.findIndex((hit) => (
        hit.citation.artifactVersionId === indexed.artifactVersionId
        && normalizedText(hit.citation.quotedText).includes(expectedQuote)
      ));
      if (hitIndex < 0) throw new Error(`multi_document_verified_citation_missing:${claim.id}`);
      const hit = searchResult.hits[hitIndex];
      if (!hit) throw new Error(`multi_document_verified_hit_missing:${claim.id}`);
      verifiedClaims.push({ claim, citation: hit.citation, rank: hitIndex + 1, score: hit.score });
    }
    if (new Set(verifiedClaims.map((item) => item.claim.inputId)).size < 2) {
      throw new Error("multi_document_cross_source_coverage_missing");
    }

    const memoryStore = new GovernedMemoryStore(db);
    const at = `${parameters.asOf}T12:00:00.000Z`;
    const evidenceRefs = [...indexedByInputId.values()].map((item) => item.artifactVersionId).sort();
    const memoryId = `multi-rag-${sha256(Buffer.from(`${parameters.memory.entityRef}:${parameters.memory.conflictKey}:${parameters.memory.summary}`)).slice(0, 24)}`;
    const candidate = memoryStore.createCandidate({
      record: {
        id: memoryId,
        kind: "semantic",
        scope: {
          tenantId: "evaluation",
          principalId: principal.id,
          caseId: context.manifest.taskContract.caseId,
        },
        entityRefs: [parameters.memory.entityRef],
        effectivePeriod: parameters.memory.effectivePeriod,
        content: { summary: parameters.memory.summary },
        sourceEvidenceRefs: evidenceRefs,
        confidence: 1,
        sensitivity: "internal",
        createdAt: at,
        owner: principal,
      },
      conflictKey: parameters.memory.conflictKey,
    });
    const approved = memoryStore.approve({
      memoryId: candidate.id,
      approver: principal,
      reason: "preproduction fixture explicitly approves cross-document retrieval context",
      at,
    });
    const selectedMemory = memoryStore.retrieve({
      principal,
      tenantId: "evaluation",
      caseId: context.manifest.taskContract.caseId,
      entityRefs: [parameters.memory.entityRef],
      effectivePeriod: parameters.memory.effectivePeriod,
      kinds: ["semantic"],
      queryText: parameters.memory.summary,
      maximumSensitivity: "confidential",
      minimumConfidence: 1,
      limit: 10,
      now: at,
    }).find((selection) => selection.memory.id === approved.id);
    if (!selectedMemory || selectedMemory.summary !== parameters.memory.summary) {
      throw new Error("multi_document_governed_memory_not_retrieved");
    }
    if (evidenceRefs.some((evidenceRef) => !selectedMemory.evidenceRefs.includes(evidenceRef))) {
      throw new Error("multi_document_memory_evidence_incomplete");
    }

    const report = {
      schemaVersion: 1 as const,
      title: parameters.reportTitle,
      subtitle: `证据截止 ${parameters.asOf}`,
      metadata: [
        { label: "来源数量", value: String(sourceRecords.length) },
        { label: "已验证结论", value: String(verifiedClaims.length) },
        { label: "检索引擎", value: "BM25 lexical" },
      ],
      sections: [
        {
          id: "governed-context",
          heading: "受控上下文",
          paragraphs: [`已审批记忆：${selectedMemory.summary}`],
          tables: [],
        },
        ...verifiedClaims.map(({ claim, citation, rank, score }, index) => ({
          id: `claim-${index + 1}`,
          heading: claim.statement,
          paragraphs: [
            `结论：${claim.statement}`,
            `原文：${citation.quotedText}`,
            `来源版本：${citation.artifactVersionId}`,
            `检索排名：${rank}；得分：${score.toFixed(6)}`,
            `检索定位：${JSON.stringify(citation.locator)}`,
            `业务定位：${JSON.stringify(claim.sourceLocator)}`,
          ],
          tables: [],
        })),
      ],
      footer: `Finwork 多文档可追溯报告 · ${evidenceRefs.map((item) => item.slice(0, 8)).join(" · ")}`,
    };
    const docxName = `${path.basename(parameters.outputName, path.extname(parameters.outputName))}.docx`;
    const generated = await generateDocx({ report, outputRoot: context.workDir, outputName: docxName });
    const validated = await validateDocxFile({
      filePath: generated.outputPath,
      fileName: docxName,
      expectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      qualityProfile: "generic",
      expectedSha256: generated.sha256,
    });
    if (validated.status !== "passed") {
      throw new Error(`multi_document_docx_validation_failed:${JSON.stringify(validated.errors)}`);
    }
    const generatedDocument = await parseDocumentFile(generated.outputPath, "docx");
    const generatedText = requireDocumentContent("multi_document_output", generatedDocument);
    const requiredOutputText = [
      selectedMemory.summary,
      ...verifiedClaims.flatMap(({ claim, citation }) => [claim.statement, citation.quotedText, citation.artifactVersionId]),
    ];
    const missingOutputText = requiredOutputText.filter((text) => !normalizedText(generatedText).includes(normalizedText(text)));
    if (missingOutputText.length > 0) throw new Error(`multi_document_output_text_missing:${missingOutputText.join("|")}`);
    const rendered = renderDocxToPdf({
      sourcePath: generated.outputPath,
      outputRoot: path.join(context.workDir, "rendered"),
      outputName: path.basename(parameters.outputName),
    });

    const mutatedInputs = sourceRecords.filter((source) => !source.bytes.equals(fs.readFileSync(source.inputPath)));
    if (mutatedInputs.length > 0) throw new Error(`multi_document_mutated_sources:${mutatedInputs.map((item) => item.inputId).join(",")}`);
    const elapsedMs = performance.now() - started;
    return {
      executionClass: "production",
      sourceInputId: parameters.sourceInputIds[0]!,
      outputPath: rendered.outputPath,
      sourceLocator: parameters.claims[0]!.sourceLocator,
      toolVersions: {
        documentParser: "finwork.document-ir:v1",
        retrieval: "bm25-index-v1",
        memory: "governed-memory-v2",
        documentGenerator: generated.producer,
        documentValidator: validated.validatorId,
        visualRender: `${rendered.provider}:${rendered.version ?? "unknown"}`,
      },
      validation: {
        structuralDiff: {
          status: "passed",
          details: { sourceCount: sourceRecords.length, sourcesUnchanged: true, sourceHashes: Object.fromEntries(sourceRecords.map((source) => [source.inputId, source.sha256])) },
        },
        visualRender: {
          status: "passed",
          details: { pdf: path.basename(rendered.outputPath), sha256: rendered.sha256, bytes: rendered.bytes, durationMs: rendered.durationMs },
        },
        recalculationOrParse: {
          status: "passed",
          details: {
            sourceNodeCounts: Object.fromEntries([...parsedDocuments].map(([inputId, document]) => [inputId, document.nodes.length])),
            outputNodes: generatedDocument.nodes.length,
            validator: validated.validatorId,
          },
        },
        businessAssertions: {
          status: "passed",
          details: {
            crossSourceCount: new Set(verifiedClaims.map((item) => item.claim.inputId)).size,
            citations: verifiedClaims.map(({ claim, citation, rank, score }) => ({ claimId: claim.id, rank, score, citation })),
            approvedMemoryId: approved.id,
          },
        },
      },
      claims: verifiedClaims.map(({ claim, citation, rank, score }) => ({
        statement: claim.statement,
        structuredValue: {
          inputId: claim.inputId,
          rank,
          score,
          quotedText: citation.quotedText,
          artifactVersionId: citation.artifactVersionId,
          locator: citation.locator,
        },
      })),
      dimensions: {
        memory: 1,
        rag: 1,
        performance: context.manifest.taskContract.budget.wallTimeMs === null
          || elapsedMs <= context.manifest.taskContract.budget.wallTimeMs ? 1 : 0,
      },
      metrics: {
        wallTimeMs: elapsedMs,
        sourceDocumentCount: sourceRecords.length,
        sourceNodeCount: [...parsedDocuments.values()].reduce((sum, document) => sum + document.nodes.length, 0),
        retrievalHitCount,
        verifiedClaimCount: verifiedClaims.length,
        citedSourceCount: new Set(verifiedClaims.map((item) => item.claim.inputId)).size,
        retrievedMemoryCount: 1,
        generatedDocxBytes: generated.bytes,
        outputBytes: rendered.bytes,
      },
    };
  } finally {
    db.close();
  }
}

async function consolidationPreflight(context: PreproductionScenarioContext): Promise<string[]> {
  let parameters: ConsolidationParameters;
  try {
    parameters = parseParameters(context);
  } catch (error) {
    return [`fixture_parameters_invalid:${error instanceof Error ? error.message : String(error)}`];
  }
  try {
    resolveFixtureInput(context, parameters.sourceInputId);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const probe = await spreadsheetProbe();
  if (!probe.data) return [`spreadsheet_probe_failed:${probe.errorCode ?? "unknown"}:${probe.detail ?? ""}`];
  const blockers = probe.data.problems
    .filter((problem) => problem.severity === "blocking")
    .map((problem) => `spreadsheet_dependency_blocked:${problem.code}`);
  if (!probe.data.recalc.ok) blockers.push(`spreadsheet_recalc_unavailable:${probe.data.recalc.errorCode ?? "unknown"}`);
  if (!probe.data.render.ok) blockers.push("spreadsheet_render_unavailable");
  return [...new Set(blockers)];
}

async function executeConsolidation(context: PreproductionScenarioContext): Promise<PreproductionScenarioExecution> {
  const started = performance.now();
  const parameters = parseParameters(context);
  const sourcePath = resolveFixtureInput(context, parameters.sourceInputId);
  fs.mkdirSync(context.workDir, { recursive: true });
  const patchedPath = path.join(context.workDir, "controlled-patch.xlsx");
  const sourceBefore = fs.readFileSync(sourcePath);

  const patchResult = requireOk(
    "controlled_patch",
    await spreadsheetPatchWorkbook(sourcePath, patchedPath, parameters.edits as WorkbookEdit[]),
  );
  if (patchResult.missing.length > 0) throw new Error(`controlled_patch_missing:${JSON.stringify(patchResult.missing)}`);
  if (patchResult.staleFormulaCount > 0) throw new Error(`controlled_patch_stale_formulas:${patchResult.staleFormulaCount}`);
  if (patchResult.formulaOnlyCount > 0) throw new Error(`controlled_patch_formula_only:${patchResult.formulaOnlyCount}`);
  if (patchResult.unresolvedFormulaCells.length > 0) {
    throw new Error(`controlled_patch_unresolved:${patchResult.unresolvedFormulaCells.join(",")}`);
  }
  if (!sourceBefore.equals(fs.readFileSync(sourcePath))) throw new Error("controlled_patch_mutated_source");

  const diff = requireOk(
    "structural_diff",
    await spreadsheetCompareAllowedCells(
      sourcePath,
      patchedPath,
      parameters.allowedChanges.sheet,
      parameters.allowedChanges.columns,
    ),
  );
  if (diff.disallowedChanges.length > 0) {
    throw new Error(`structural_diff_disallowed:${diff.disallowedChanges.slice(0, 20).join(",")}`);
  }
  if (diff.changedCount === 0) throw new Error("structural_diff_empty");

  const recalcDir = path.join(context.workDir, "recalculated");
  const recalc = requireOk("recalculation", await spreadsheetRecalc(patchedPath, { workCopyDir: recalcDir }));
  const expectedAddresses = Object.keys(parameters.expectedCells);
  const inspected = requireOk("business_assertion_inspection", await spreadsheetInspectCells(recalc.outputPath, expectedAddresses));
  const mismatches = expectedAddresses.flatMap((address) => {
    const expected = parameters.expectedCells[address] ?? null;
    const actual = inspected.values[address] ?? null;
    return valuesEqual(actual, expected, parameters.numericTolerance)
      ? []
      : [{ address, expected, actual }];
  });
  if (mismatches.length > 0) throw new Error(`business_assertion_mismatch:${JSON.stringify(mismatches)}`);

  const renderDir = path.join(context.workDir, "rendered");
  const rendered = requireOk("visual_render", await spreadsheetRender(recalc.outputPath, renderDir));
  const emptyRenders = rendered.files.filter((file) => !fs.existsSync(file) || fs.statSync(file).size === 0);
  if (emptyRenders.length > 0 || rendered.files.length === 0) throw new Error("visual_render_empty");

  const outputPath = path.join(context.workDir, path.basename(parameters.outputName));
  if (path.resolve(recalc.outputPath) !== path.resolve(outputPath)) fs.copyFileSync(recalc.outputPath, outputPath);
  const elapsedMs = performance.now() - started;
  return {
    executionClass: "production",
    sourceInputId: parameters.sourceInputId,
    outputPath,
    sourceLocator: parameters.sourceLocator,
    toolVersions: {
      controlledPatch: "finance_worker.patch-workbook:v1",
      structuralDiff: "finance_worker.compare-excel-allowlist:v1",
      recalculation: `${recalc.provider}:${recalc.version ?? "unknown"}`,
      inspection: "finance_worker.inspect-excel-cells:v1",
      visualRender: `${rendered.provider}:pdf`,
    },
    validation: {
      structuralDiff: { status: "passed", details: diff },
      visualRender: {
        status: "passed",
        details: { files: rendered.files.map((file) => path.basename(file)), durationMs: rendered.durationMs },
      },
      recalculationOrParse: {
        status: "passed",
        details: { provider: recalc.provider, version: recalc.version ?? "unknown", formulaCount: recalc.formulaCount ?? 0, durationMs: recalc.durationMs },
      },
      businessAssertions: {
        status: "passed",
        details: { expectedCells: parameters.expectedCells, actualCells: inspected.values, tolerance: parameters.numericTolerance },
      },
    },
    claims: [{
      statement: `集团合并底稿已通过 ${expectedAddresses.length} 个关键单元格断言、受控变更检查、真实重算与 PDF 渲染。`,
      structuredValue: { expectedCells: parameters.expectedCells, actualCells: inspected.values },
    }],
    dimensions: {
      contract: 1,
      artifact: 1,
      evidence: 1,
      security: 1,
      performance: context.manifest.taskContract.budget.wallTimeMs === null
        || elapsedMs <= context.manifest.taskContract.budget.wallTimeMs ? 1 : 0,
    },
    metrics: {
      wallTimeMs: elapsedMs,
      patchAppliedCount: patchResult.applied.length,
      changedCellCount: diff.changedCount,
      businessAssertionCount: expectedAddresses.length,
      renderedFileCount: rendered.files.length,
      recalcDurationMs: recalc.durationMs,
      renderDurationMs: rendered.durationMs,
    },
  };
}

export function createConsolidationPreproductionAdapter(): PreproductionScenarioAdapter {
  return {
    id: "production.consolidation.controlled-workbook.v1",
    manifestId: "golden.consolidation",
    preflight: consolidationPreflight,
    execute: executeConsolidation,
  };
}

export function createTaxPayrollPreproductionAdapter(): PreproductionScenarioAdapter {
  return {
    id: "production.tax-payroll.rag-memory-rules-docx.v1",
    manifestId: "golden.tax-payroll",
    preflight: taxPayrollPreflight,
    execute: executeTaxPayroll,
  };
}

export function createMultiDocumentRagPreproductionAdapter(): PreproductionScenarioAdapter {
  return {
    id: "production.multi-document-rag.hybrid-citations-pdf.v1",
    manifestId: "golden.multi-document-rag",
    preflight: multiDocumentRagPreflight,
    execute: executeMultiDocumentRag,
  };
}

export function createBuiltInPreproductionAdapters(): PreproductionScenarioAdapter[] {
  return [
    createConsolidationPreproductionAdapter(),
    createTaxPayrollPreproductionAdapter(),
    createMultiDocumentRagPreproductionAdapter(),
    createWebDueDiligencePreproductionAdapter(),
  ];
}
