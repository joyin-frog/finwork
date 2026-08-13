import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type { PrincipalRef } from "@/lib/capability/common";
import type { ResourceBudget } from "@/lib/resource/contracts";
import type { DataHandlingPolicy } from "@/lib/security/contracts";

/** Production-owned identity shared by a task, its case and nested runs. */
export type AgentFoundationContext = {
  taskId: string;
  caseId: string;
  runId: string;
  tenantId: string;
  principal: PrincipalRef;
  security: DataHandlingPolicy;
  budget: ResourceBudget;
};

export type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentIntent =
  | "greeting"
  | "trivial_qa"
  | "rag_qa"
  | "tool_task"
  | "complex_workflow";

export type AgentAttachment = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  text?: string;
  storagePath?: string;
};

export type AgentQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string; preview?: string }>;
  questions?: AgentQuestion[];
  kind?: "confirm";
  trustable?: boolean;
};

export type FinworkAgentRequest = {
  messages: AgentMessage[];
  runtimeSessionId?: string | null;
  resumeSession?: boolean;
  requestId?: string;
  attachments?: AgentAttachment[];
  outputDir?: string;
  emit?: (event: AgentRuntimeEvent) => void;
  onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void;
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
  signal?: AbortSignal;
  modelOverride?: string;
  traceId?: string;
  conversationId?: number;
  roleId?: string | null;
  taskContract?: import("./run-contract").TaskContract | null;
  /** Explicit governance boundary for Memory v2. Free-form chat must not invent these fields. */
  memoryContext?: Partial<import("@/lib/memory-v2/contracts").MemoryRuntimeContext> | null;
  executionTier?: import("@/lib/settings/model-config").ExecutionTier | null;
  /** Router fact used only for conservative context narrowing; absence keeps the full catalog. */
  intent?: AgentIntent;
  /** Agent code must propagate this identity instead of deriving another case id. */
  foundation?: AgentFoundationContext;
};

export type FinworkAgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** Per-model usage shape retained by trace/quota during AR9 normalization. */
export type AgentModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type FinworkAgentResult = {
  mode: "agent" | "mock";
  runtimeSessionId: string | null;
  content: string;
  usage?: FinworkAgentUsage;
  modelUsage?: Record<string, AgentModelUsage>;
  totalCostUsd?: number;
  numTurns?: number;
  roleMode?: string;
  terminationReason?: string;
  repairRounds?: number;
  repairStopReason?: "completed" | "no_progress" | "max_rounds" | "not_required";
  verificationStatus?: "passed" | "not_applicable";
};
