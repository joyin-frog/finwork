import type {
  AgentAttachment,
  AgentRunContext,
  AgentIntent,
} from "@/lib/agent/contracts";
import type { DeliverySpec } from "@/lib/agent/run-contract";

export type AgentTaskMode = "chat" | "action" | "deliverable";

/**
 * Small production task description consumed by the Agent hot path.
 *
 * `delivery` is intentionally absent for chat/action so those runs do not
 * acquire Case/DAG/Evidence state merely because Pi may use a tool.
 */
export type AgentTaskSpec = {
  mode: AgentTaskMode;
  delivery?: DeliverySpec;
};

export function createAgentTaskSpec(input: {
  contract: DeliverySpec;
  intent?: AgentIntent;
  attachments?: readonly AgentAttachment[];
}): AgentTaskSpec {
  if (input.contract.requiredDeliverables.length > 0) {
    return { mode: "deliverable", delivery: input.contract };
  }
  if (
    input.contract.taskKind !== "text"
    || (input.attachments?.length ?? 0) > 0
    || input.intent === "tool_task"
    || input.intent === "complex_workflow"
  ) {
    return { mode: "action" };
  }
  return { mode: "chat" };
}

/**
 * Security/resource identity for a Pi run. This is not a persisted Task/Case
 * and does not create a plan or evidence records.
 */
export function createAgentRunContext(input: {
  runId: string;
  goal: string;
  allowExternalEgress?: boolean;
  allowedDomains?: string[];
}): AgentRunContext {
  const allowedDomains = input.allowExternalEgress ? (input.allowedDomains ?? []) : [];
  const principal = { id: "local-user", type: "user" as const, tenantId: "local" };
  return {
    taskId: `run-${input.runId}`,
    caseId: `run-${input.runId}`,
    runId: input.runId,
    tenantId: "local",
    principal,
    security: {
      classification: "confidential",
      allowedPrincipals: [principal],
      allowExternalEgress: allowedDomains.length > 0,
      allowedDomains,
      requireEncryptionAtRest: true,
      requireHumanApprovalForExport: false,
    },
    budget: {
      tokenLimit: 500_000,
      wallTimeMs: 4 * 60 * 60 * 1_000,
      cpuTimeMs: 2 * 60 * 60 * 1_000,
      memoryBytes: 1024 * 1024 * 1024,
      diskBytes: 2 * 1024 * 1024 * 1024,
      networkBytes: 256 * 1024 * 1024,
      toolOutputBytes: 64 * 1024 * 1024,
      concurrency: 2,
      retryLimit: 0,
    },
  };
}

export function resolveResearchEgress(goal: string): { allowExternalEgress: boolean; allowedDomains: string[] } {
  if (!/尽调|尽职调查|联网|网络搜索|公开资料|外部资料|due\s*diligence|web\s*research/i.test(goal)) {
    return { allowExternalEgress: false, allowedDomains: [] };
  }
  const configured = (process.env.FINWORK_RESEARCH_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const endpoint = process.env.FINWORK_RESEARCH_GATEWAY_URL?.trim();
  if (endpoint) {
    try { configured.push(new URL(endpoint).hostname.toLowerCase()); } catch { /* provider rejects invalid config */ }
  }
  const allowedDomains = [...new Set(configured)];
  return { allowExternalEgress: allowedDomains.length > 0, allowedDomains };
}
