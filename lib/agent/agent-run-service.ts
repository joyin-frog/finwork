import type { DatabaseSync } from "node:sqlite";
import type {
  AgentAttachment,
  AgentRunContext,
  AgentIntent,
  AgentWorkPlanSummary,
} from "@/lib/agent/contracts";
import type { DeliverySpec } from "@/lib/agent/run-contract";
import {
  createAgentRunContext,
  createAgentTaskSpec,
  resolveResearchEgress,
  type AgentTaskSpec,
} from "@/lib/agent/task-spec";
import {
  beginDeliveryRun,
  type DeliveryRun,
} from "@/lib/task/production-runtime";

export type PreparedAgentRun = {
  task: AgentTaskSpec;
  context: AgentRunContext;
  plan?: AgentWorkPlanSummary;
  delivery?: DeliveryRun;
};

/**
 * The single preparation boundary for an HTTP or desktop Agent run.
 * Chat/action receive only a run context. Persisted Task/Case/Plan/Evidence is
 * allocated exclusively for a declared deliverable.
 */
export function prepareAgentRun(input: {
  db: DatabaseSync;
  traceId: string;
  conversationId?: number;
  goal: string;
  attachments: AgentAttachment[];
  deliverySpec: DeliverySpec;
  roleId?: string | null;
  intent?: AgentIntent;
}): PreparedAgentRun {
  const task = createAgentTaskSpec({
    contract: input.deliverySpec,
    intent: input.intent,
    attachments: input.attachments,
  });
  if (task.mode !== "deliverable") {
    return {
      task,
      context: createAgentRunContext({
        runId: input.traceId,
        goal: input.goal,
        ...resolveResearchEgress(input.goal),
      }),
    };
  }

  const delivery = beginDeliveryRun({
    db: input.db,
    traceId: input.traceId,
    conversationId: input.conversationId,
    goal: input.goal,
    attachments: input.attachments,
    deliverySpec: input.deliverySpec,
    roleId: input.roleId,
    intent: input.intent,
  });
  return { task, context: delivery.runContext, plan: delivery.plan, delivery };
}
