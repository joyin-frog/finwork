import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sha256Json } from "@/lib/capability/hash";
import { runMigrations } from "@/lib/db/migrations";
import { generateDocx, probeDocxPdfRenderer, renderDocxToPdf } from "@/lib/document-generation";
import { parseDocumentFile } from "@/lib/document-ir/adapters";
import { GovernedMemoryStore } from "@/lib/memory-v2/store";
import {
  DUE_DILIGENCE_TOPICS,
  DueDiligenceTopicSchema,
  HttpResearchGatewayProvider,
  ResearchProviderRegistry,
  ResearchQueryPlanSchema,
  ResearchService,
  ResearchSourcePolicySchema,
  ResearchSubjectSchema,
  type ResearchClaimBinding,
  type ResearchReport,
} from "@/lib/research";
import { SecurityAuthorizer } from "@/lib/security/kernel";
import { TaskStore } from "@/lib/task";
import type {
  PreproductionScenarioAdapter,
  PreproductionScenarioContext,
  PreproductionScenarioExecution,
} from "./preproduction-e2e";

const EffectivePeriodSchema = z.object({
  start: z.iso.date(),
  end: z.iso.date(),
  label: z.string().trim().min(1).max(200).optional(),
}).strict().refine((period) => period.start <= period.end, {
  message: "effectivePeriod.start must be before or equal to end",
  path: ["end"],
});

const WebDueDiligenceParametersSchema = z.object({
  requestInputId: z.string().trim().min(1),
  outputName: z.string().trim().min(1).regex(/\.pdf$/i).default("尽职调查报告.pdf"),
  reportTitle: z.string().trim().min(1).max(300).default("联网尽职调查报告"),
  providerId: z.literal("production-research-gateway"),
  subject: ResearchSubjectSchema,
  topics: z.array(DueDiligenceTopicSchema).length(DUE_DILIGENCE_TOPICS.length),
  queries: z.array(z.string().trim().min(1).max(2_000)).min(1),
  languages: z.array(z.string().trim().min(1).max(35)).min(1),
  asOf: z.iso.datetime({ offset: true }),
  maxSources: z.number().int().min(2).max(100),
  policy: ResearchSourcePolicySchema,
  memory: z.object({
    entityRef: z.string().trim().min(1).max(200),
    conflictKey: z.string().trim().min(1).max(200),
    effectivePeriod: EffectivePeriodSchema,
  }).strict(),
}).strict().superRefine((parameters, context) => {
  const topics = new Set(parameters.topics);
  for (const topic of DUE_DILIGENCE_TOPICS) {
    if (!topics.has(topic)) {
      context.addIssue({ code: "custom", path: ["topics"], message: `missing due-diligence topic: ${topic}` });
    }
  }
  if (topics.size !== parameters.topics.length) {
    context.addIssue({ code: "custom", path: ["topics"], message: "due-diligence topics must be unique" });
  }
  if (parameters.policy.allowedDomains.length === 0) {
    context.addIssue({ code: "custom", path: ["policy", "allowedDomains"], message: "web due diligence requires an explicit domain allowlist" });
  }
});

type WebDueDiligenceParameters = z.infer<typeof WebDueDiligenceParametersSchema>;

function parseParameters(context: PreproductionScenarioContext): WebDueDiligenceParameters {
  return WebDueDiligenceParametersSchema.parse(context.fixture.parameters);
}

function resolveFixtureInput(context: PreproductionScenarioContext, inputId: string): string {
  const input = context.fixture.inputs.find((candidate) => candidate.id === inputId);
  if (!input) throw new Error(`fixture input not found: ${inputId}`);
  const root = path.resolve(context.fixtureRoot);
  const target = path.resolve(root, input.path);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`fixture input escapes root: ${input.path}`);
  return target;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 120) || randomUUID();
}

function normalizedDomain(value: string): string {
  return new URL(value).hostname.toLowerCase();
}

function reportSummary(report: ResearchReport): string {
  const verified = report.claims.filter((claim) => claim.status === "verified");
  return verified.map((claim) => `[${claim.topic}] ${claim.statement}`).join("；").slice(0, 2_000);
}

function topicLabel(topic: string): string {
  return ({
    entity: "主体资格",
    ownership: "股权与控制",
    people: "关键人员",
    litigation: "诉讼",
    penalty: "行政处罚",
    finance: "财务",
    media: "媒体与声誉",
    related_parties: "关联方",
  } as Record<string, string>)[topic] ?? topic;
}

function requireGatewayConfiguration(): { endpoint: string; token: string } {
  const endpoint = process.env.FINWORK_RESEARCH_GATEWAY_URL?.trim();
  const token = process.env.FINWORK_RESEARCH_GATEWAY_TOKEN?.trim();
  if (!endpoint) throw new Error("research_gateway_url_missing");
  if (!token) throw new Error("research_gateway_token_missing");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") throw new Error("research_gateway_requires_https");
  return { endpoint, token };
}

async function preflight(context: PreproductionScenarioContext): Promise<string[]> {
  let parameters: WebDueDiligenceParameters;
  try {
    parameters = parseParameters(context);
  } catch (error) {
    return [`fixture_parameters_invalid:${error instanceof Error ? error.message : String(error)}`];
  }
  const blockers: string[] = [];
  try {
    const requestPath = resolveFixtureInput(context, parameters.requestInputId);
    if (!fs.existsSync(requestPath) || !fs.statSync(requestPath).isFile()) blockers.push(`fixture_missing:${parameters.requestInputId}`);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  if (!context.allowExternalEgress) blockers.push("external_egress_not_authorized");
  if (!context.manifest.taskContract.security.allowExternalEgress) blockers.push("task_contract_external_egress_disabled");
  const contractDomains = new Set(context.manifest.taskContract.security.allowedDomains.map((domain) => domain.toLowerCase()));
  for (const domain of parameters.policy.allowedDomains) {
    if (!contractDomains.has(domain)) blockers.push(`source_domain_not_in_task_contract:${domain}`);
  }
  try {
    requireGatewayConfiguration();
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  const renderer = probeDocxPdfRenderer();
  if (!renderer.ok) blockers.push(`document_renderer_unavailable:${renderer.detail}`);
  return [...new Set(blockers)];
}

function createResearchReportDocument(parameters: WebDueDiligenceParameters, report: ResearchReport) {
  const verified = report.claims.filter((claim) => claim.status === "verified");
  return {
    schemaVersion: 1 as const,
    title: parameters.reportTitle,
    subtitle: `证据截止 ${parameters.asOf}`,
    metadata: [
      { label: "调查主体", value: parameters.subject.legalName },
      { label: "司法辖区", value: parameters.subject.jurisdiction },
      { label: "来源快照", value: String(report.snapshots.length) },
      { label: "已验证结论", value: String(verified.length) },
    ],
    sections: [
      {
        id: "coverage",
        heading: "调查覆盖",
        paragraphs: [],
        tables: [{
          caption: "八类尽调主题覆盖状态",
          columns: ["主题", "状态", "来源数", "结论数", "未知原因"],
          rows: report.coverage.map((item) => [
            topicLabel(item.topic), item.status, String(item.sourceCount), String(item.claimIds.length), item.unknownReason ?? "",
          ]),
        }],
      },
      {
        id: "findings",
        heading: "已验证发现",
        paragraphs: verified.length > 0 ? [] : ["没有达到证据门槛的可验证结论。"],
        tables: verified.length > 0 ? [{
          caption: "逐声明证据引用",
          columns: ["主题", "结论", "快照", "字符范围", "引用哈希"],
          rows: verified.map((claim) => [
            topicLabel(claim.topic), claim.statement, claim.snapshotId,
            claim.locator.kind === "char_range" ? `${claim.locator.start}-${claim.locator.end}` : JSON.stringify(claim.locator),
            claim.quoteHash,
          ]),
        }] : [],
      },
      {
        id: "conflicts-unknowns",
        heading: "冲突与未知",
        paragraphs: [
          report.conflicts.length > 0
            ? `存在 ${report.conflicts.length} 组未解决来源冲突；冲突结论不得作为确定事实。`
            : "未发现相互矛盾且达到比较条件的来源结论。",
          ...(report.unknowns.length > 0 ? report.unknowns : ["八类主题均有已验证覆盖。"]),
        ],
        tables: [],
      },
      {
        id: "sources",
        heading: "来源快照与审计信息",
        paragraphs: [],
        tables: [{
          caption: "不可变来源快照",
          columns: ["快照", "来源等级", "可信评分", "抓取时间", "地址", "内容哈希", "污染标记"],
          rows: report.snapshots.map((snapshot) => [
            snapshot.id, snapshot.sourceClass, snapshot.rating.total.toFixed(4), snapshot.fetchedAt,
            snapshot.finalUrl, snapshot.contentHash, snapshot.taints.join("、") || "无",
          ]),
        }],
      },
      {
        id: "rejections",
        heading: "拒绝来源",
        paragraphs: report.rejectedSources.length > 0
          ? report.rejectedSources.map((source) => `${source.code}｜${source.url}｜${source.reason}`)
          : ["无被策略或证据校验拒绝的来源。"],
        tables: [],
      },
    ],
    footer: `Finwork 可审计联网尽调 · plan ${report.plan.id}`,
  };
}

async function execute(context: PreproductionScenarioContext): Promise<PreproductionScenarioExecution> {
  const started = performance.now();
  const parameters = parseParameters(context);
  const { endpoint, token } = requireGatewayConfiguration();
  if (!context.allowExternalEgress) throw new Error("external_egress_not_authorized");
  const requestPath = resolveFixtureInput(context, parameters.requestInputId);
  const requestBefore = fs.readFileSync(requestPath);
  fs.mkdirSync(context.workDir, { recursive: true });

  const databasePath = path.join(context.workDir, "web-due-diligence.sqlite");
  const db = new DatabaseSync(databasePath);
  const principal = { id: "evaluation.service", type: "service" as const, tenantId: "evaluation" };
  const now = parameters.asOf;
  try {
    runMigrations(db, databasePath, () => null);
    const taskStore = new TaskStore(db);
    taskStore.saveContract(context.manifest.taskContract);
    taskStore.createCase(context.manifest.taskContract.id, context.manifest.taskContract.caseId, `research-${randomUUID()}`);

    const authorizer = new SecurityAuthorizer(db);
    authorizer.grant({
      id: randomUUID(), principal, tenantId: "evaluation", caseId: context.manifest.taskContract.caseId,
      capabilityId: "research.web", actions: ["network", "write"], createdAt: now,
    });
    const gatewayDomain = normalizedDomain(endpoint);
    const expiresAt = new Date(Date.parse(now) + 60 * 60 * 1_000).toISOString();
    for (const domain of new Set([gatewayDomain, ...parameters.policy.allowedDomains])) {
      authorizer.grantEgress({
        id: randomUUID(), principal, tenantId: "evaluation", caseId: context.manifest.taskContract.caseId,
        capabilityId: "research.web", domain, expiresAt, createdAt: now,
      });
    }

    const provider = new HttpResearchGatewayProvider({
      id: parameters.providerId,
      endpoint,
      token,
      timeoutMs: 30_000,
      maxResponseBytes: Math.min(20_000_000, context.manifest.taskContract.budget.networkBytes ?? 20_000_000),
      retry: { maxAttempts: context.manifest.taskContract.budget.retryLimit + 1 },
      authorizeDomain: ({ domain }) => {
        authorizer.authorizeOrThrow({
          principal, tenantId: "evaluation", caseId: context.manifest.taskContract.caseId,
          capabilityId: "research.web", action: "network", classification: "confidential",
          taints: [], destinationDomain: domain, now,
        });
      },
    });
    const providers = new ResearchProviderRegistry();
    providers.register(provider);
    const service = new ResearchService(db, path.join(context.workDir, "research-cas"), providers, () => new Date(now));
    const plan = ResearchQueryPlanSchema.parse({
      id: `research-${randomUUID()}`,
      caseId: context.manifest.taskContract.caseId,
      providerId: parameters.providerId,
      subject: parameters.subject,
      topics: parameters.topics,
      queries: parameters.queries,
      languages: parameters.languages,
      asOf: parameters.asOf,
      maxSources: parameters.maxSources,
      policy: parameters.policy,
    });
    const report = await service.execute(plan, { principal, tenantId: "evaluation", authorizer });
    if (report.publicationGate.status !== "publishable") {
      throw new Error(`web_due_diligence_publication_blocked:${report.publicationGate.blockers.join(",")}`);
    }
    const verified = report.claims.filter((claim) => claim.status === "verified");
    if (report.snapshots.length < 2) throw new Error("web_due_diligence_requires_multiple_source_snapshots");
    if (verified.length === 0) throw new Error("web_due_diligence_has_no_verified_claims");
    if (new Set(verified.map((claim) => claim.snapshotId)).size < 2) {
      throw new Error("web_due_diligence_verified_claims_require_multiple_sources");
    }
    for (const claim of verified) {
      if (!service.verifyClaimQuote(claim.claimId)) throw new Error(`web_due_diligence_claim_quote_invalid:${claim.claimId}`);
      const snapshot = report.snapshots.find((item) => item.id === claim.snapshotId);
      if (!snapshot) throw new Error(`web_due_diligence_snapshot_missing:${claim.snapshotId}`);
      if (snapshot.taints.includes("prompt_injection")) throw new Error(`prompt_injection_claim_was_verified:${claim.claimId}`);
    }

    const memorySummary = reportSummary(report);
    if (!memorySummary) throw new Error("web_due_diligence_memory_summary_empty");
    const memoryStore = new GovernedMemoryStore(db);
    const memoryId = `web-dd-${sha256(Buffer.from(`${parameters.memory.entityRef}:${parameters.memory.conflictKey}:${memorySummary}`)).slice(0, 24)}`;
    const candidate = memoryStore.createCandidate({
      record: {
        id: memoryId,
        kind: "semantic",
        scope: { tenantId: "evaluation", principalId: principal.id, caseId: context.manifest.taskContract.caseId },
        entityRefs: [parameters.memory.entityRef],
        effectivePeriod: parameters.memory.effectivePeriod,
        content: { summary: memorySummary },
        sourceEvidenceRefs: verified.map((claim) => claim.evidenceId),
        confidence: 1,
        sensitivity: "confidential",
        createdAt: now,
        owner: principal,
      },
      conflictKey: parameters.memory.conflictKey,
    });
    const approved = memoryStore.approve({
      memoryId: candidate.id,
      approver: principal,
      reason: "preproduction due-diligence findings are backed by exact immutable citations",
      at: now,
    });
    const selectedMemory = memoryStore.retrieve({
      principal, tenantId: "evaluation", caseId: context.manifest.taskContract.caseId,
      entityRefs: [parameters.memory.entityRef], effectivePeriod: parameters.memory.effectivePeriod,
      kinds: ["semantic"], maximumSensitivity: "confidential", minimumConfidence: 1, limit: 10, now,
    }).find((selection) => selection.memory.id === approved.id);
    if (!selectedMemory || selectedMemory.summary !== memorySummary) throw new Error("web_due_diligence_governed_memory_not_retrieved");

    const documentReport = createResearchReportDocument(parameters, report);
    const docxName = `${path.basename(parameters.outputName, path.extname(parameters.outputName))}.docx`;
    const generated = await generateDocx({ report: documentReport, outputRoot: context.workDir, outputName: docxName });
    const generatedDocument = await parseDocumentFile(generated.outputPath, "docx");
    const generatedText = generatedDocument.nodes.map((node) => node.text ?? "").join("\n");
    for (const required of [parameters.subject.legalName, ...verified.map((claim) => claim.statement)]) {
      if (!generatedText.includes(required)) throw new Error(`web_due_diligence_output_text_missing:${required}`);
    }
    const rendered = renderDocxToPdf({
      sourcePath: generated.outputPath,
      outputRoot: path.join(context.workDir, "rendered"),
      outputName: path.basename(parameters.outputName),
    });

    const snapshotsRoot = path.join(context.workDir, "research-evidence");
    fs.mkdirSync(snapshotsRoot, { recursive: true });
    const evidenceSources = report.snapshots.map((snapshot) => {
      const body = service.readSnapshot(snapshot.id);
      const snapshotPath = path.join(snapshotsRoot, `${safeFileName(snapshot.id)}.snapshot`);
      fs.writeFileSync(snapshotPath, body, { encoding: "utf8", mode: 0o600 });
      const bodyBytes = fs.readFileSync(snapshotPath);
      const actualHash = sha256(bodyBytes);
      if (actualHash !== snapshot.contentHash) throw new Error(`materialized_snapshot_hash_mismatch:${snapshot.id}`);
      return {
        id: snapshot.id,
        path: snapshotPath,
        sha256: actualHash,
        mediaType: snapshot.contentType,
        logicalName: `${snapshot.id}.snapshot`,
        locator: { kind: "char_range" as const, nodeId: snapshot.id, start: 0, end: body.length },
        metadata: {
          requestedUrl: snapshot.requestedUrl,
          finalUrl: snapshot.finalUrl,
          fetchedAt: snapshot.fetchedAt,
          sourceClass: snapshot.sourceClass,
          rating: snapshot.rating.total,
          taints: snapshot.taints,
        },
      };
    });
    if (!requestBefore.equals(fs.readFileSync(requestPath))) throw new Error("web_due_diligence_mutated_request_fixture");
    const elapsedMs = performance.now() - started;
    const claims = verified.map((claim: ResearchClaimBinding) => ({
      statement: claim.statement,
      structuredValue: { topic: claim.topic, status: claim.status, snapshotId: claim.snapshotId },
      citations: [{ evidenceSourceId: claim.snapshotId, locator: claim.locator, quoteHash: claim.quoteHash }],
    }));
    return {
      executionClass: "production",
      outputPath: rendered.outputPath,
      evidenceSources,
      toolVersions: {
        researchProvider: "finwork.http-research-gateway:v1",
        researchService: "finwork.research-service:v1",
        securityKernel: "finwork.security-kernel:v1",
        memory: "governed-memory-v2",
        documentGenerator: generated.producer,
        visualRender: `${rendered.provider}:${rendered.version ?? "unknown"}`,
      },
      validation: {
        structuralDiff: { status: "passed", details: { topicCount: report.coverage.length, report: documentReport } },
        visualRender: { status: "passed", details: { pdf: path.basename(rendered.outputPath), sha256: rendered.sha256, bytes: rendered.bytes } },
        recalculationOrParse: { status: "passed", details: { verifiedClaims: verified.length, allQuoteHashesVerified: true } },
        businessAssertions: {
          status: "passed",
          details: {
            subject: parameters.subject,
            sourceCount: report.snapshots.length,
            verifiedSourceCount: new Set(verified.map((claim) => claim.snapshotId)).size,
            conflicts: report.conflicts,
            unknowns: report.unknowns,
            rejectedSources: report.rejectedSources,
            promptInjectionClaimsVerified: 0,
            approvedMemoryId: approved.id,
          },
        },
      },
      claims,
      dimensions: {
        memory: 1,
        security: 1,
        performance: context.manifest.taskContract.budget.wallTimeMs === null
          || elapsedMs <= context.manifest.taskContract.budget.wallTimeMs ? 1 : 0,
      },
      metrics: {
        wallTimeMs: elapsedMs,
        sourceSnapshotCount: report.snapshots.length,
        verifiedClaimCount: verified.length,
        verifiedSourceCount: new Set(verified.map((claim) => claim.snapshotId)).size,
        conflictCount: report.conflicts.length,
        unknownCount: report.unknowns.length,
        rejectedSourceCount: report.rejectedSources.length,
        outputBytes: rendered.bytes,
      },
    };
  } finally {
    db.close();
  }
}

export function createWebDueDiligencePreproductionAdapter(): PreproductionScenarioAdapter {
  return {
    id: "production.web-due-diligence.audited-gateway-pdf.v1",
    manifestId: "golden.web-due-diligence",
    preflight,
    execute,
  };
}
