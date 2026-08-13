import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type { AgentFoundationContext } from "@/lib/agent/contracts";

export type SubagentTask = {
  roleId: string;
  instructions: string;
  files?: string[];
  label: string;
  taskTemplateId?: string;
  businessObject?: string;
  period?: string;
  existingDispatchId?: number;
};

export type SubagentResult = {
  label: string;
  content: string;
  success: boolean;
  durationMs: number;
};

export type SubagentRunOptions = {
  parentOutputDir: string;
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
