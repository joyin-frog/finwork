import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentAttachment, AgentMessage } from "@/lib/agent/contracts";
import {
  runAgentTurn,
  type AgentTurnCollector,
  type AgentTurnParams,
  type AgentTurnResult,
} from "@/lib/agent/production-turn";
import { createEmitter } from "@/lib/agent/runtime-events";
import {
  createRunPersistenceContext,
  markRunRunning,
  persistRuntimeEnvelope,
} from "@/lib/agent/run-event-persistence";
import { runRouter } from "@/lib/agent/router";
import { resolveRunExecutionModel } from "@/lib/agent/resolve-run-model";
import {
  persistAgentTurn,
  persistIncompleteTurn,
  type PersistTurnParams,
} from "@/lib/agent/turn-persistence";
import { ArtifactStore } from "@/lib/artifacts/store";
import { DocumentLocatorSchema, type ArtifactRef } from "@/lib/artifacts/contracts";
import { sha256Json } from "@/lib/capability/hash";
import { EvidenceLedger } from "@/lib/evidence/ledger";
import { SecurityAuthorizer } from "@/lib/security/kernel";
import { authorizeEvidenceWrite } from "@/lib/security/evidence-authorization";
import {
  installProductionRetrievalService,
  ProductionRetrievalService,
} from "@/lib/retrieval/production";
import {
  createChatConversation,
  getDb,
  insertChatMessage,
} from "@/lib/db/sqlite";
import { readAgentSettings, type AgentSettings } from "@/lib/settings/agent-settings";
import { getAppDataDir, getConversationFilesDir, getRunFileWorkspacePaths } from "@/lib/runtime/paths";
import { wrapExternalContext } from "@/lib/agent/external-context";
import { beginProductionTaskRun, type ProductionTaskSettlement } from "@/lib/task/production-runtime";
import {
  classifyTransientProviderError,
  withTransientProviderRetry,
} from "@/lib/evaluation/transient-provider-retry";
import {
  BenchmarkPredictionSchema,
  type BenchmarkCitation,
  type BenchmarkExecutionCase,
  type BenchmarkExecutionContext,
  type BenchmarkExecutor,
  type BenchmarkPrediction,
} from "./contracts";
import { createLegacyBenchmarkTaskContract } from "./task-contract";

type RouterResult = Awaited<ReturnType<typeof runRouter>>;
export interface ProductionBenchmarkExecutorOptions {
  db?: DatabaseSync;
  casRoot?: string;
  now?: () => number;
  readSettings?: () => Promise<AgentSettings>;
  route?: (
    message: string,
    history: AgentMessage[],
    traceId: string,
    context: { runtimeSessionId: null; conversationId: number },
  ) => Promise<RouterResult>;
  /** Test seam at the provider service boundary; production uses runPiAgent. */
  agentRunner?: AgentTurnParams["agentRunner"];
  sleep?: (delayMs: number) => Promise<void>;
  /** Production keeps adaptive routing; fixed-agent skips the paid router and isolates the Agent stack. */
  evaluationMode?: "production" | "fixed-agent";
  /** Required with fixed-agent; inherited by the main session and every subagent. */
  fixedModel?: string;
}

/**
 * Execute a benchmark case through the same task, Agent, tool, security,
 * resource, artifact, evidence and delivery boundaries as an interactive turn.
 * The executor only receives BenchmarkExecutionCase; it has no Oracle channel.
 */
export function createProductionBenchmarkExecutor(
  options: ProductionBenchmarkExecutorOptions = {},
): BenchmarkExecutor {
  return async (executionCase, context) => executeProductionBenchmarkCase(
    executionCase,
    context,
    options,
  );
}

export async function executeProductionBenchmarkCase(
  executionCase: BenchmarkExecutionCase,
  context: BenchmarkExecutionContext,
  options: ProductionBenchmarkExecutorOptions = {},
): Promise<BenchmarkPrediction> {
  if (options.evaluationMode === "fixed-agent" && !options.fixedModel?.trim()) {
    throw new Error("fixed-agent evaluation requires fixedModel");
  }
  const startedAt = (options.now ?? Date.now)();
  const db = options.db ?? getDb();
  const traceId = randomUUID();
  const casRoot = options.casRoot ?? path.join(getAppDataDir(), "artifacts", "cas");
  const conversationId = createChatConversation(`Benchmark: ${executionCase.datasetId}/${executionCase.upstreamCaseId}`);
  const prompt = formatBenchmarkAgentPrompt(executionCase);
  const attachments = materializeInputAttachments({
    db,
    casRoot,
    conversationId,
    inputArtifacts: executionCase.inputs,
    publicFiles: executionCase.context.files,
  });
  insertChatMessage(conversationId, "user", prompt);
  const agentMessages: AgentMessage[] = [
    ...executionCase.context.conversation.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: "user", content: prompt },
  ];
  const requiresRetrieval = executionCase.capabilities.includes("retrieval")
    || executionCase.capabilities.includes("citation");
  const routerResult: RouterResult = options.evaluationMode === "fixed-agent"
    ? fixedAgentRoute(executionCase, requiresRetrieval)
    : await (options.route ?? runRouter)(
        prompt,
        agentMessages,
        traceId,
        { runtimeSessionId: null, conversationId },
      );
  const effectiveRouterResult: RouterResult = requiresRetrieval
    ? {
        ...routerResult,
        path: "main",
        decision: {
          ...routerResult.decision,
          intent: "rag_qa",
          directAnswer: undefined,
          needsRag: true,
          reasoning: `${routerResult.decision.reasoning}; benchmark task contract requires governed retrieval`,
        },
      }
    : routerResult;
  const settings = await (options.readSettings ?? readAgentSettings)();
  const resolvedModel = options.evaluationMode === "fixed-agent"
    ? {
        modelId: options.fixedModel!.trim(),
        executionRole: "agent" as const,
        executionTier: "reasoning" as const,
      }
    : resolveRunExecutionModel({
        settings,
        routerPath: effectiveRouterResult.path,
        routerFailureHint: effectiveRouterResult.path === "fallback" ? effectiveRouterResult.decision.reasoning : null,
      });
  const legacyContract = createLegacyBenchmarkTaskContract(context.taskContract);
  const runPaths = getRunFileWorkspacePaths(traceId);
  const outputDir = runPaths.work;
  for (const directory of [runPaths.inputs, runPaths.work, runPaths.outputs]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const beforeGenerate = snapshotConversationFiles(conversationId);
  const beforeWorking = snapshotFilesUnder(outputDir);
  const runPersist = createRunPersistenceContext({
    runId: traceId,
    traceId,
    conversationId,
    modelUsed: resolvedModel?.modelId ?? null,
    modelRole: resolvedModel?.executionRole ?? null,
    executionTier: resolvedModel?.executionTier ?? null,
    modelFallbackReason: resolvedModel?.fallbackReason ?? null,
    status: "queued",
  });
  const lifecycleEmitter = createEmitter(traceId, conversationId);
  persistRuntimeEnvelope(lifecycleEmitter.wrap({ type: "run_started", conversationId }), runPersist);
  markRunRunning(runPersist, (event) => lifecycleEmitter.wrap(event));
  const productionTaskContract = {
    ...context.taskContract,
    id: `benchmark-task-run:${traceId}`,
    caseId: `benchmark-case-run:${traceId}`,
  };

  const productionRun = beginProductionTaskRun({
    db,
    traceId,
    conversationId,
    goal: productionTaskContract.goal,
    attachments: [],
    legacyContract,
    taskContract: productionTaskContract,
    inputArtifacts: executionCase.inputs,
    principalId: "benchmark-runner",
    tenantId: "benchmark",
    casRoot,
  });
  const persistParams: PersistTurnParams = {
    conversationId,
    existingRuntimeSessionId: null,
    beforeGenerate,
    beforeWorking,
    outputDir,
    traceId,
    startedAt,
    routerResult: effectiveRouterResult,
    lastUserContent: prompt,
    roleMode: settings.roleMode,
    resolvedModel,
  };
  let lastCollector: AgentTurnCollector = { collectedChunks: [], collectedEvents: [] };
  let completedResult: AgentTurnResult | undefined;
  let turnPersisted = false;
  let attempts = 0;
  const contractWallTimeMs = context.taskContract.budget.wallTimeMs ?? undefined;
  const restoreRetrievalService = requiresRetrieval
    ? installProductionRetrievalService(new ProductionRetrievalService({
        db,
        artifacts: new ArtifactStore(db, casRoot),
        principal: { id: "benchmark-runner", type: "service", tenantId: "benchmark" },
        allowedArtifactVersionIds: executionCase.inputs.map((artifact) => artifact.versionId),
      }))
    : () => undefined;

  try {
    const retried = await withTransientProviderRetry(async (attempt) => {
      attempts = attempt;
      try {
        const turn = await runAgentTurn({
          traceId,
          agentMessages,
          runtimeSessionId: null,
          existingRuntimeSessionId: null,
          attachments,
          outputDir,
          routerResult: effectiveRouterResult,
          conversationId,
          modelOverride: resolvedModel?.modelId,
          runPersist,
          taskContract: legacyContract,
          executionTier: resolvedModel?.executionTier ?? null,
          foundation: productionRun.foundation,
          signal: context.signal,
          resolveUserQuestion: async () => {
            const error = new Error("headless benchmark requires a human decision");
            error.name = "HumanDecisionRequiredError";
            throw error;
          },
          onRuntimeEvent: (event) => productionRun.recordRuntimeEvent(event),
          agentServiceOptions: {
            ...(contractWallTimeMs === undefined ? {} : {
              hardTimeoutMs: contractWallTimeMs,
              abortTimeoutMs: Math.min(2_000, contractWallTimeMs),
            }),
            ...(options.evaluationMode === "fixed-agent"
              ? { nestedModelOverride: options.fixedModel!.trim() }
              : {}),
          },
          agentRunner: options.agentRunner,
        });
        lastCollector = turn.collector;
        return turn;
      } catch (error) {
        lastCollector = (error as { __collector?: AgentTurnCollector }).__collector ?? lastCollector;
        throw error;
      }
    }, {
      maxAttempts: Math.min(2, context.taskContract.budget.retryLimit + 1),
      signal: context.signal,
      deadlineAt: contractWallTimeMs === undefined ? undefined : startedAt + contractWallTimeMs,
      now: options.now,
      sleep: options.sleep,
      shouldRetry: () => isSideEffectFree(lastCollector),
    });
    attempts = retried.attempts;
    const { result, collector } = retried.value;
    completedResult = result;
    lastCollector = collector;
    const persisted = persistAgentTurn({
      ...persistParams,
      retryCount: attempts - 1,
      result,
      collector,
    });
    turnPersisted = true;
    persistInlineBenchmarkCitations({
      db,
      executionCase,
      caseId: productionRun.caseId,
      traceId,
      assistantContent: result.content,
      foundation: productionRun.foundation,
    });
    productionRun.markValidating();
    let settlement: ProductionTaskSettlement;
    try {
      settlement = productionRun.settle({
        // The supplied V3 benchmark contract is the authoritative completion
        // boundary. The v1 contract exists only for Pi/finalize compatibility.
        outcome: "completed",
        assistantMessageId: persisted.messageId,
      });
    } catch (error) {
      settlement = productionRun.getSettlement() ?? productionRun.settle({ outcome: "error", message: "settlement failed" });
      throw attachSettlement(error, settlement);
    }
    persistTerminalLifecycle(lifecycleEmitter, runPersist, "completed");
    return assemblePersistedPrediction({
      db,
      traceId,
      conversationId,
      caseId: productionRun.caseId,
      settlement,
      attempts,
      fallbackResult: result,
      startedAt,
      now: options.now ?? Date.now,
    });
  } catch (error) {
    const aborted = context.signal?.aborted || isAbortError(error);
    const diagnostic = safeBenchmarkDiagnostic(error, [settings.apiKey]);
    let settlement: ProductionTaskSettlement | undefined =
      (error as { __benchmarkSettlement?: ProductionTaskSettlement }).__benchmarkSettlement
      ?? productionRun.getSettlement()
      ?? undefined;
    if (!settlement) {
      try {
        settlement = productionRun.settle({
          outcome: aborted ? "aborted" : "error",
          message: diagnostic.message,
        });
      } catch {
        settlement = productionRun.getSettlement() ?? undefined;
      }
    }
    const failure = stableFailureFor(error, aborted, settlement?.stableFailureCode, diagnostic);
    // A deterministic task-contract failure can happen after the provider turn
    // was already persisted successfully. Do not duplicate the assistant turn
    // or overwrite its non-zero trace usage with an "incomplete" zero-usage
    // trace in that case.
    if (!turnPersisted) {
      persistIncompleteTurn({
        ...persistParams,
        retryCount: Math.max(0, attempts - 1),
        collector: lastCollector,
        errorMessage: diagnostic.message,
        modelUsage: (error as { __modelUsage?: Record<string, never> }).__modelUsage,
      });
    }
    persistTerminalLifecycle(lifecycleEmitter, runPersist, aborted ? "aborted" : "error", failure.code);
    return assemblePersistedPrediction({
      db,
      traceId,
      conversationId,
      caseId: productionRun.caseId,
      settlement,
      attempts: Math.max(1, attempts),
      fallbackResult: completedResult,
      startedAt,
      now: options.now ?? Date.now,
      failure,
    });
  } finally {
    restoreRetrievalService();
  }
}

function fixedAgentRoute(
  executionCase: BenchmarkExecutionCase,
  requiresRetrieval: boolean,
): RouterResult {
  const intent = requiresRetrieval
    ? "rag_qa" as const
    : executionCase.taskKind === "spreadsheet" || executionCase.taskKind === "agent"
      ? "complex_workflow" as const
      : "tool_task" as const;
  return {
    path: "main",
    latencyMs: 0,
    decision: {
      intent,
      needsRag: requiresRetrieval,
      reasoning: "fixed-agent evaluation: deterministic routing, paid router disabled",
    },
  };
}

export function formatBenchmarkAgentPrompt(executionCase: BenchmarkExecutionCase): string {
  const sections = [executionCase.prompt];
  if (executionCase.context.conversation.length > 0) {
    sections.push([
      "<benchmark-conversation-history>",
      ...executionCase.context.conversation.map((turn) => `${turn.role}: ${turn.text}`),
      "</benchmark-conversation-history>",
      "以上是同一任务已确认的对话历史；延续其中约束。历史中用户已经明确作出的决定就是当前任务输入，不要重复询问或调用工具重新推翻，除非用户明确要求重新核验。当前消息若明确声明相对历史的范围变化，则以该变化请求为当前输入：先说明变化，并在高风险写入前请求明确确认，不得把旧决定解释成永久禁止变更。",
    ].join("\n"));
  }
  if (executionCase.requirements.artifactOutput) {
    sections.push([
      "本任务必须交付一个不可变文件产物。",
      `输出文件名必须精确为：${JSON.stringify(executionCase.requirements.artifactOutput.logicalName)}`,
      `输出媒体类型必须为：${JSON.stringify(executionCase.requirements.artifactOutput.mediaType)}`,
      "调用交付工具时必须提交这个精确文件名；其他文件名不满足任务合同。",
    ].join("\n"));
  }
  if (executionCase.taskKind === "spreadsheet") {
    sections.push([
      "严格保留原工作簿的业务语义、布局与留空约定，只修改完成任务所必需的单元格。",
      "标签含 Reported 的行表示历史已报告数据：如果模板中的预测期单元格原本为空，预测期必须继续留空；不要把 Normalized、Adjusted 或 Projected 行的公式复制到 Reported 行。",
      "预测只填写模板明确用于 Normalized、Adjusted、Derived、Margin、Growth 或 Projected 的行。",
    ].join("\n"));
  }
  const requiresRetrieval = executionCase.capabilities.includes("retrieval")
    || executionCase.capabilities.includes("citation");
  if (requiresRetrieval) {
    const sourceIds = [
      ...executionCase.context.textBlocks.map((block) => block.id),
      ...executionCase.context.tables.map((table) => table.id),
      ...executionCase.context.files.map((file) => file.logicalName),
    ];
    sections.push([
      "本任务合同要求受 ACL 约束的证据检索。",
      "回答前必须调用 search_knowledge；不得绕过该工具，也不得把未检索到的事实写成已确认结论。",
      ...(sourceIds.length > 0
        ? [
            `本任务已物化的公开来源标识：${sourceIds.map((id) => JSON.stringify(id)).join("、")}。`,
            "检索查询优先包含这些 sourceId 和用户问题中的核心业务名词；首轮为空时必须换用 sourceId 加核心名词再检索一次。",
            "检索结果已经包含完成任务所需事实时直接作答，不要要求用户重复上传同一材料。",
          ]
        : []),
    ].join("\n"));
  } else if (executionCase.context.textBlocks.length > 0) {
    sections.push([
      "以下是已经随任务提供并完成物化的参考数据（包括从附件提取的文本）；可直接读取，无需检查会话目录或要求用户重新上传。",
      wrapExternalContext(executionCase.context.textBlocks.map((block) =>
        [
          `[sourceId=${block.id} locator=${block.locator ?? `node:${block.id}`}]${block.title ? ` ${block.title}` : ""}`,
          block.text,
        ].join("\n")
      ).join("\n\n")),
    ].join("\n"));
  }
  for (const table of requiresRetrieval ? [] : executionCase.context.tables) {
    sections.push([
      "以下表格已随任务提供并完成物化；可直接读取，无需查找或重新上传附件。",
      wrapExternalContext([
        `[sourceId=${table.id} type=table]`,
        table.columns.join("\t"),
        ...table.rows.map((row, index) =>
          `[locator=node:${table.id}-row-${index + 1}]\t${row.join("\t")}`
        ),
      ].join("\n")),
    ].join("\n"));
  }
  if (executionCase.requirements.requiresCitations) {
    sections.push([
      "回答中的引用必须对应已见到的稳定 sourceId 和精确 locator；不要编造引用。",
      "在答案末尾使用机器可校验标记：[[cite sourceId=\"<sourceId>\" locator=\"<locator>\"]]。",
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function persistInlineBenchmarkCitations(input: {
  db: DatabaseSync;
  executionCase: BenchmarkExecutionCase;
  caseId: string;
  traceId: string;
  assistantContent: string;
  foundation: ReturnType<typeof beginProductionTaskRun>["foundation"];
}): void {
  if (!input.executionCase.requirements.requiresCitations) return;
  const publicLocators = new Map<string, { locator: ReturnType<typeof DocumentLocatorSchema.parse>; quote: string }>();
  for (const block of input.executionCase.context.textBlocks) {
    const locatorText = block.locator ?? `node:${block.id}`;
    const locator = locatorText.startsWith("page:")
      ? { kind: "page" as const, page: Number(locatorText.slice("page:".length)) }
      : { kind: "node" as const, nodeId: locatorText.slice("node:".length) || block.id };
    publicLocators.set(`${block.id}\u0000${locatorText}`, {
      locator,
      quote: block.text,
    });
  }
  for (const table of input.executionCase.context.tables) {
    table.rows.forEach((row, index) => {
      const locatorText = `node:${table.id}-row-${index + 1}`;
      publicLocators.set(`${table.id}\u0000${locatorText}`, {
        locator: { kind: "node", nodeId: `${table.id}-row-${index + 1}` },
        quote: [table.columns, row].map((value) => value.join("\t")).join("\n"),
      });
    });
  }
  const artifactsBySourceId = new Map<string, ArtifactRef>();
  for (const artifact of input.executionCase.inputs) {
    const row = input.db.prepare(`
      SELECT metadata_json FROM artifact_versions WHERE version_id = ?
    `).get(artifact.versionId) as { metadata_json: string } | undefined;
    const metadata = row ? safeJson(row.metadata_json) as Record<string, unknown> : {};
    const sourceId = typeof metadata.sourceId === "string" ? metadata.sourceId.trim() : "";
    if (sourceId) artifactsBySourceId.set(sourceId, artifact);
  }
  const ledger = new EvidenceLedger(input.db);
  const authorizer = new SecurityAuthorizer(input.db);
  const marker = /\[\[cite\s+sourceId="([^"]+)"\s+locator="([^"]+)"\]\]/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = marker.exec(input.assistantContent)) !== null) {
    const sourceId = match[1]!.trim();
    const locatorText = match[2]!.trim();
    const publicSource = publicLocators.get(`${sourceId}\u0000${locatorText}`);
    const artifact = artifactsBySourceId.get(sourceId);
    if (!publicSource || !artifact) continue;
    const sourceRow = input.db.prepare(`
      SELECT evidence_id, output_hash FROM evidence_records
      WHERE case_id = ? AND evidence_type = 'source' AND artifact_version_id = ?
      ORDER BY created_at, evidence_id LIMIT 1
    `).get(input.caseId, artifact.versionId) as { evidence_id: string; output_hash: string } | undefined;
    if (!sourceRow) continue;
    const locator = DocumentLocatorSchema.parse(publicSource.locator);
    const createdAt = new Date().toISOString();
    const policyDecisionId = authorizeEvidenceWrite({
      authorizer,
      principal: input.foundation.principal,
      tenantId: input.foundation.tenantId,
      caseId: input.caseId,
      capabilityId: "agent.turn",
      artifactVersionId: artifact.versionId,
      classification: input.foundation.security.classification,
      now: createdAt,
    });
    const extraction = ledger.addEvidence(input.caseId, {
      id: randomUUID(),
      type: "extraction",
      artifact,
      locator,
      producer: {
        capabilityId: "agent.turn",
        version: "benchmark-inline-citation-v1",
        attemptId: `${input.traceId}-inline-citation-${index}`.slice(0, 200),
      },
      inputs: [{ evidenceId: sourceRow.evidence_id, outputHash: sourceRow.output_hash }],
      outputHash: sha256Json(publicSource.quote),
      policyDecisionId,
      createdAt,
    });
    const claimId = randomUUID();
    ledger.addClaim({
      id: claimId,
      caseId: input.caseId,
      statement: publicSource.quote.slice(0, 20_000),
      evidenceRefs: [extraction.id],
      status: "verified",
    });
    ledger.addCitation({
      id: randomUUID(),
      claimId,
      artifactVersionId: artifact.versionId,
      locator,
      quoteHash: sha256Json(publicSource.quote),
      createdAt,
    });
    index += 1;
  }
}

function materializeInputAttachments(input: {
  db: DatabaseSync;
  casRoot: string;
  conversationId: number;
  inputArtifacts: readonly ArtifactRef[];
  publicFiles: readonly BenchmarkExecutionCase["context"]["files"][number][];
}): AgentAttachment[] {
  if (input.inputArtifacts.length === 0 || input.publicFiles.length === 0) return [];
  const explicitVersionIds = new Set(input.publicFiles.flatMap((file) =>
    file.artifactRef ? [file.artifactRef.versionId] : []
  ));
  const publicFileKeys = new Set(input.publicFiles.map((file) => `${file.logicalName}\u0000${file.mediaType}`));
  const attachable = input.inputArtifacts.filter((artifact) =>
    explicitVersionIds.has(artifact.versionId)
    || publicFileKeys.has(`${artifact.logicalName}\u0000${artifact.mediaType}`)
  );
  if (attachable.length === 0) return [];
  const artifacts = new ArtifactStore(input.db, input.casRoot);
  const uploadDir = path.join(getConversationFilesDir(input.conversationId), "upload");
  fs.mkdirSync(uploadDir, { recursive: true });
  return attachable.map((artifact, index) => {
    const content = artifacts.read(artifact.versionId);
    const safeName = `${String(index + 1).padStart(2, "0")}-${path.basename(artifact.logicalName)}`;
    const storagePath = path.join(uploadDir, safeName);
    fs.writeFileSync(storagePath, content, { mode: 0o600 });
    return {
      name: artifact.logicalName,
      mimeType: artifact.mediaType,
      size: content.byteLength,
      dataUrl: "",
      storagePath,
      ...(isInlineTextMedia(artifact.mediaType) ? { text: Buffer.from(content).toString("utf8") } : {}),
    };
  });
}

function isInlineTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

function snapshotConversationFiles(conversationId: number): Set<string> {
  return snapshotFilesUnder(getConversationFilesDir(conversationId));
}

function snapshotFilesUnder(root: string): Set<string> {
  if (!fs.existsSync(root)) return new Set();
  const files = new Set<string>();
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.add(candidate);
    }
  };
  visit(root);
  return files;
}

function isSideEffectFree(collector: AgentTurnCollector): boolean {
  return collector.collectedChunks.length === 0
    && !collector.collectedEvents.some((event) =>
      event.type === "tool_use" || event.type === "tool_result" || event.type === "file"
    );
}

function attachSettlement(error: unknown, settlement: ProductionTaskSettlement): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  (target as Error & { __benchmarkSettlement?: ProductionTaskSettlement }).__benchmarkSettlement = settlement;
  return target;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled|canceled/i.test(error.message));
}

function stableFailureFor(
  error: unknown,
  aborted: boolean,
  settlementCode?: string | null,
  diagnostic = safeBenchmarkDiagnostic(error, []),
): NonNullable<BenchmarkPrediction["failure"]> {
  const details = diagnosticDetails(diagnostic);
  if (aborted) return { kind: "canceled", code: "benchmark_aborted", source: "resource", details };
  if (error instanceof Error && error.name === "HumanDecisionRequiredError") {
    return { kind: "human_decision_required", code: "benchmark_human_decision_required", source: "policy", details };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || /deadline|timeout|timed out/i.test(error.message))) {
    return { kind: "resource_exhausted", code: "benchmark_wall_time_exceeded", source: "resource", details };
  }
  if (/task contract denies external egress/i.test(diagnostic.message)) {
    return { kind: "permission_denied", code: "task_contract_external_egress_denied", source: "policy", details };
  }
  if (/auth_unavailable|no auth available/i.test(diagnostic.message)) {
    return { kind: "dependency_unavailable", code: "provider_auth_unavailable", source: "dependency", details };
  }
  const provider = classifyTransientProviderError(error);
  if (provider.status === 401 || provider.status === 403) {
    return { kind: "dependency_unavailable", code: "provider_auth_failed", source: "dependency", details: { ...details, status: provider.status } };
  }
  if (provider.status === 400 || provider.status === 404) {
    return { kind: "dependency_unavailable", code: "provider_model_or_endpoint_invalid", source: "dependency", details: { ...details, status: provider.status } };
  }
  if (provider.status === 429) {
    return { kind: "transient_external_failure", code: "provider_rate_limited", source: "dependency", details: { ...details, status: provider.status } };
  }
  if (provider.status !== undefined && provider.status >= 500) {
    return { kind: "transient_external_failure", code: "provider_unavailable", source: "dependency", details: { ...details, status: provider.status } };
  }
  if (provider.retryable) {
    return { kind: "transient_external_failure", code: provider.reason, source: "dependency", details: { ...details, status: provider.status ?? null } };
  }
  if (settlementCode) {
    if (/validator|evidence|assertion/.test(settlementCode)) {
      return { kind: "deterministic_validation_failed", code: settlementCode, source: "validator", details };
    }
    if (/policy|permission/.test(settlementCode)) {
      return { kind: "permission_denied", code: settlementCode, source: "policy", details };
    }
    if (/timeout|budget|resource/.test(settlementCode)) {
      return { kind: "resource_exhausted", code: settlementCode, source: "resource", details };
    }
    return { kind: "capability_missing", code: settlementCode, source: "capability", details };
  }
  return { kind: "internal_error", code: "production_agent_failed", source: "capability", details };
}

type BenchmarkErrorDiagnostic = {
  name: string;
  message: string;
  upstreamCode?: string;
  fingerprint: string;
};

function safeBenchmarkDiagnostic(error: unknown, secrets: readonly string[]): BenchmarkErrorDiagnostic {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const name = error instanceof Error && error.name.trim() ? error.name.trim() : "UnknownError";
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  for (const secret of secrets.filter((value) => value.length >= 4)) {
    message = message.split(secret).join("<redacted-secret>");
  }
  message = message
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-secret>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted-secret>")
    .replace(/(?:\/Users\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/g, "<redacted-user-path>")
    .slice(0, 1_000)
    .trim() || "benchmark execution failed";
  const rawCode = record?.code;
  const upstreamCode = typeof rawCode === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode)
    ? rawCode
    : undefined;
  return {
    name,
    message,
    ...(upstreamCode ? { upstreamCode } : {}),
    fingerprint: sha256Json({ name, message, upstreamCode: upstreamCode ?? null }),
  };
}

function diagnosticDetails(diagnostic: BenchmarkErrorDiagnostic): Record<string, string> {
  return {
    errorName: diagnostic.name,
    errorFingerprint: diagnostic.fingerprint,
    ...(diagnostic.upstreamCode ? { upstreamCode: diagnostic.upstreamCode } : {}),
  };
}

function persistTerminalLifecycle(
  emitter: ReturnType<typeof createEmitter>,
  runPersist: ReturnType<typeof createRunPersistenceContext>,
  outcome: "completed" | "aborted" | "error",
  message?: string,
): void {
  persistRuntimeEnvelope(emitter.wrap({
    type: "run_ended",
    kind: outcome === "completed" ? "complete" : "incomplete",
    ...(message ? { message } : {}),
  }), runPersist);
  persistRuntimeEnvelope(emitter.wrap({
    type: "run_settled",
    outcome,
    ...(message ? { error: message } : {}),
  }), runPersist);
}

function assemblePersistedPrediction(input: {
  db: DatabaseSync;
  traceId: string;
  conversationId: number;
  caseId: string;
  settlement?: ProductionTaskSettlement;
  attempts: number;
  fallbackResult?: AgentTurnResult;
  startedAt: number;
  now: () => number;
  failure?: NonNullable<BenchmarkPrediction["failure"]>;
}): BenchmarkPrediction {
  const assistant = input.db.prepare(`
    SELECT content FROM chat_messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY id DESC LIMIT 1
  `).get(input.conversationId) as { content: string } | undefined;
  const trace = input.db.prepare(`
    SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           total_cost_usd, total_ms, tool_call_count, retry_count
    FROM agent_traces WHERE trace_id = ?
  `).get(input.traceId) as {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    total_cost_usd: number | null;
    total_ms: number | null;
    tool_call_count: number | null;
    retry_count: number | null;
  } | undefined;
  const modelUsage = input.fallbackResult && "modelUsage" in input.fallbackResult
    ? input.fallbackResult.modelUsage
    : undefined;
  const usage = Object.values(modelUsage ?? {}).reduce((total, value) => ({
    input: total.input + value.inputTokens,
    output: total.output + value.outputTokens,
    cacheRead: total.cacheRead + value.cacheReadInputTokens,
    cacheCreation: total.cacheCreation + value.cacheCreationInputTokens,
  }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  const assertions = input.db.prepare(`
    SELECT assertion_id, validator_id, status, blocking, details_json
    FROM assertion_results WHERE case_id = ? ORDER BY assertion_id
  `).all(input.caseId) as Array<{
    assertion_id: string;
    validator_id: string;
    status: string;
    blocking: number;
    details_json: string;
  }>;
  const citations = loadPersistedCitations(input.db, input.caseId);
  const delivered = input.settlement?.artifactRefs.find((artifact) => artifact.state === "delivered");
  const checks = assertions.map((row) => ({
    id: row.validator_id,
    passed: row.status === "passed",
    blocking: row.blocking === 1,
    details: safeJson(row.details_json),
  }));
  const latencyMs = Math.max(0, trace?.total_ms ?? (input.now() - input.startedAt));
  return BenchmarkPredictionSchema.parse({
    ...(assistant?.content ? { answer: assistant.content } : {}),
    citations,
    ...(delivered ? {
      artifact: {
        mediaType: delivered.mediaType,
        sha256: delivered.sha256,
        checks,
      },
    } : {}),
    assertions: assertions.filter((row) => row.status === "passed").map((row) => row.assertion_id),
    metrics: {
      wallTimeMs: latencyMs,
      tokens: (trace?.input_tokens ?? usage.input)
        + (trace?.output_tokens ?? usage.output)
        + (trace?.cache_read_tokens ?? usage.cacheRead)
        + (trace?.cache_creation_tokens ?? usage.cacheCreation),
      retries: Math.max(trace?.retry_count ?? 0, input.attempts - 1),
      toolCalls: trace?.tool_call_count ?? 0,
    },
    ...(input.failure ? { failure: input.failure } : {}),
    execution: {
      traceId: input.traceId,
      caseId: input.caseId,
      taskId: input.settlement?.taskId ?? `benchmark-task:${input.caseId}`,
      runId: input.settlement?.runId ?? input.traceId,
      conversationId: input.conversationId,
      inputTokens: trace?.input_tokens ?? usage.input,
      outputTokens: trace?.output_tokens ?? usage.output,
      cacheReadInputTokens: trace?.cache_read_tokens ?? usage.cacheRead,
      cacheCreationInputTokens: trace?.cache_creation_tokens ?? usage.cacheCreation,
      latencyMs,
      retries: Math.max(trace?.retry_count ?? 0, input.attempts - 1),
      costUsd: trace?.total_cost_usd ?? (input.fallbackResult && "totalCostUsd" in input.fallbackResult
        ? input.fallbackResult.totalCostUsd ?? null
        : null),
      artifactRefs: input.settlement?.artifactRefs ?? [],
      evidenceRefs: input.settlement?.evidenceRefs ?? [],
      validation: input.settlement ? {
        assertions: input.settlement.validation.assertions,
        delivery: {
          required: input.settlement.validation.delivery.required,
          delivered: input.settlement.validation.delivery.delivered,
          passed: input.settlement.validation.delivery.passed,
        },
      } : {
        assertions: { total: assertions.length, passed: assertions.filter((row) => row.status === "passed").length, failed: assertions.filter((row) => row.status === "failed").length },
        delivery: { required: false, delivered: 0, passed: false },
      },
      termination: {
        cancelled: input.settlement?.termination.cancelled ?? input.failure?.kind === "canceled",
        aborted: input.settlement?.termination.aborted ?? input.failure?.kind === "canceled",
        timedOut: Boolean(input.settlement?.termination.timedOut)
          || input.failure?.code === "benchmark_wall_time_exceeded",
      },
      stableFailureCode: input.failure?.code ?? input.settlement?.stableFailureCode ?? null,
    },
    details: { persisted: true },
  });
}

function loadPersistedCitations(db: DatabaseSync, caseId: string): BenchmarkCitation[] {
  const rows = db.prepare(`
    SELECT a.logical_name, av.metadata_json, cr.locator_json
    FROM citation_records cr
    JOIN claims c ON c.claim_id = cr.claim_id
    JOIN artifact_versions av ON av.version_id = cr.artifact_version_id
    JOIN artifacts a ON a.artifact_id = av.artifact_id
    WHERE c.case_id = ?
    ORDER BY cr.created_at, cr.citation_id
  `).all(caseId) as Array<{ logical_name: string; metadata_json: string; locator_json: string }>;
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const metadata = safeJson(row.metadata_json) as Record<string, unknown>;
    const sourceId = typeof metadata.sourceId === "string" && metadata.sourceId.trim()
      ? metadata.sourceId.trim()
      : row.logical_name;
    const locator = stableLocator(safeJson(row.locator_json));
    const key = `${sourceId}\u0000${locator}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ sourceId, locator }];
  });
}

function stableLocator(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const locator = value as Record<string, unknown>;
  switch (locator.kind) {
    case "page": return `page:${locator.page}`;
    case "section": return `section:${Array.isArray(locator.sectionPath) ? locator.sectionPath.join("/") : ""}`;
    case "paragraph": return `paragraph:${locator.nodeId}`;
    case "table": return `table:${locator.nodeId}`;
    case "sheet_range": return `sheet:${locator.sheet}!${locator.range}`;
    case "char_range": return `char:${locator.nodeId}:${locator.start}-${locator.end}`;
    case "bbox": return `bbox:${locator.page}:${JSON.stringify(locator.bbox)}`;
    case "node": return `node:${locator.nodeId}`;
    default: return JSON.stringify(locator);
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
