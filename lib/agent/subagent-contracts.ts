import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type { AgentFoundationContext } from "@/lib/agent/contracts";
import type { ExecutionTier } from "@/lib/settings/model-config";

export type SubagentTask = {
  roleId: string;
  instructions: string;
  files?: string[];
  label: string;
  taskTemplateId?: string;
  businessObject?: string;
  period?: string;
  existingDispatchId?: number;
  /** Deterministic cost/quality choice; missing means fast. */
  executionTier?: ExecutionTier;
};

export type SubagentResult = {
  label: string;
  content: string;
  success: boolean;
  durationMs: number;
};

export type SubagentRunOptions = {
  parentOutputDir: string;
  /** Evaluation/runtime override inherited from the parent so a fixed-model run is actually fixed. */
  modelOverride?: string;
  signal?: AbortSignal;
  conversationId?: string;
  traceId?: string;
  memoryContext?: Partial<import("@/lib/memory-v2/contracts").MemoryRuntimeContext> | null;
  foundation?: AgentFoundationContext;
  onEvent?: (event: AgentRuntimeEvent, instanceId: string) => void;
};

export type SubagentExecutor = (
  task: SubagentTask,
  options: SubagentRunOptions,
) => Promise<SubagentResult>;

export type SubagentParallelExecutor = (
  tasks: SubagentTask[],
  options: SubagentRunOptions & { concurrency?: number },
) => Promise<SubagentResult[]>;
