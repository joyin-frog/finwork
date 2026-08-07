import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type { TaskContract } from "@/lib/agent/run-contract";

export type ConfirmationExpectation = "none" | "accept" | "reject" | "accept_if_requested";
export type TaskMode = "single_turn" | "multi_turn" | "controlled_abort";

export type GoldenTurn = {
  user?: string;
  attachments?: string[];
  control?: "answer_confirmation" | "force_compaction";
  answer?: "accept" | "reject";
};

export type GoldenTask = {
  id: string;
  capability: string;
  mode: TaskMode;
  setup?: {
    knowledgeDocuments?: string[];
    businessSeed?: string;
    forceCompaction?: boolean;
    clock?: string;
  };
  turns: GoldenTurn[];
  control?: {
    abortAfterEvent: string;
    toolNameOneOf?: string[];
  };
  expected: {
    skills: string[];
    firstToolOneOf?: string[];
    requiredTools: string[];
    forbiddenTools: string[];
    confirmation: ConfirmationExpectation;
    assertions: string[];
    delivery?: { required: boolean; mimeTypes: string[] };
  };
};

export type GoldenManifest = {
  version: number;
  suite: string;
  canonicalToolNames: boolean;
  fixtureRoot: string;
  tasks: GoldenTask[];
};

export type RuntimeEventRecord = {
  at: string;
  event: AgentRuntimeEvent;
  instanceId?: string;
};

export type RuntimeConfirmation = {
  at: string;
  question: string;
  kind: "confirm" | "question";
  answer: string;
};

export type RuntimeUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalCostUsd: number | null;
  turns: number | null;
  models: string[];
};

export type RuntimeTurnRequest = {
  runId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  attachments: Array<{
    name: string;
    mimeType: string;
    size: number;
    storagePath: string;
    dataUrl: string;
  }>;
  outputDir: string;
  sessionId: string | null;
  resumeSession: boolean;
  taskContract: TaskContract;
  model: string;
  confirmation: ConfirmationExpectation;
  abortControl?: GoldenTask["control"];
};

export type RuntimeTurnResult = {
  content: string;
  sessionId: string | null;
  outcome: "completed" | "aborted" | "error";
  terminationReason: string | null;
  events: RuntimeEventRecord[];
  confirmations: RuntimeConfirmation[];
  usage: RuntimeUsage;
  error?: string;
};

export type RuntimeCompactionRequest = {
  sessionId: string;
  model: string;
};

export interface PhaseBRuntime {
  readonly id: string;
  readonly providerProtocol: string;
  readonly capabilities: {
    controlledAbort: boolean;
    forcedCompaction: boolean;
  };
  runTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult>;
  forceCompact(request: RuntimeCompactionRequest): Promise<RuntimeEventRecord[]>;
}

export type AssertionResult = {
  id: string;
  description: string;
  status: "pass" | "fail" | "not_observable";
  actual?: unknown;
};

export type FileSnapshotEntry = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type SideEffectSnapshot = {
  files: FileSnapshotEntry[];
  database: Record<string, number>;
  memorySha256: string | null;
};

export type AttemptEvidence = {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  runtime: string;
  providerProtocol: string;
  model: string | null;
  sessionIdRedacted: string | null;
  startedAt: string;
  durationMs: number;
  outcome: "completed" | "aborted" | "error";
  terminationReason: string | null;
  toolCalls: string[];
  skillLoads: string[];
  confirmations: RuntimeConfirmation[];
  usage: RuntimeUsage;
  assertions: AssertionResult[];
  completionEvidence: unknown[];
  deliverables: unknown[];
  sideEffects: {
    before: SideEffectSnapshot;
    atSettlement: SideEffectSnapshot;
    after: SideEffectSnapshot;
  };
  responseSha256: string;
  evidencePaths: string[];
  invalidRunReason: string | null;
  capabilityGaps: string[];
};

export type WorkerPayload = {
  taskId: string;
  attempt: number;
  attemptDir: string;
  model: string;
};
