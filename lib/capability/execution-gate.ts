import { createHash } from "node:crypto";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";

export type ExecutionRequirement = {
  id: string;
  description?: string;
  /** 至少命中其中一个语义能力或具体工具。 */
  anyOf: string[];
  minimumCount?: number;
};

export type ExecutionFact = {
  toolCallId: string;
  toolName: string;
  capabilityIds: string[];
  completedAt: string;
};

export type ExecutionGateDecision =
  | {
      ok: true;
      observedCapabilityIds: string[];
      diagnosticFingerprint: string;
    }
  | {
      ok: false;
      missing: Array<{ id: string; description?: string; anyOf: string[]; observedCount: number; requiredCount: number }>;
      observedCapabilityIds: string[];
      message: string;
      diagnosticFingerprint: string;
    };

export const TOOL_CAPABILITY_MAP: Readonly<Record<string, readonly string[]>> = {
  read: ["spreadsheet.read", "document.read", "filesystem.read"],
  read_file: ["spreadsheet.read", "document.read", "filesystem.read"],
  read_document: ["spreadsheet.read", "document.read"],
  read_workspace_file: ["spreadsheet.read", "document.read", "filesystem.read"],
  inspect_document_structure: ["document.read", "document.inspect"],
  patch_document: ["document.read", "document.write"],
  analyze_tabular: ["spreadsheet.read", "spreadsheet.analyze", "finance.analyze"],
  create_workbook: ["spreadsheet.write"],
  patch_workbook: ["spreadsheet.read", "spreadsheet.write"],
  patch_workspace_workbook: ["spreadsheet.read", "spreadsheet.write"],
  review_workspace_change: ["spreadsheet.validate", "workspace.change-review"],
  run_task_python: ["sandboxed.code-execution", "filesystem.write"],
  check_workbook_ties: ["spreadsheet.read", "spreadsheet.validate"],
  finalize_deliverable: ["spreadsheet.validate", "artifact.deliver"],
  search: ["retrieval.search"],
  search_knowledge: ["retrieval.search"],
  query_knowledge: ["retrieval.search"],
  research_web: ["research.web"],
  web_search: ["research.web-search"],
  fetch_url: ["research.fetch"],
  spawn_subagent: ["agent.delegate"],
};

/** Deterministic catalog lookup used by preflight before any model is called. */
export function toolsForCapability(capabilityId: string): string[] {
  const normalized = capabilityId.trim();
  if (!normalized) return [];
  if (normalized === "agent.turn") return ["agent.turn"];
  if (normalized.startsWith("finance-tool.")) {
    return [normalized.slice("finance-tool.".length)].filter((tool) => tool in TOOL_CAPABILITY_MAP);
  }
  return Object.entries(TOOL_CAPABILITY_MAP)
    .filter(([, capabilityIds]) => capabilityIds.includes(normalized))
    .map(([tool]) => tool)
    .sort();
}

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function capabilityIdsForTool(toolName: string): string[] {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return [];
  return [...new Set([
    normalized,
    `finance-tool.${normalized}`,
    ...(TOOL_CAPABILITY_MAP[normalized] ?? []),
  ])];
}

export class CapabilityExecutionLedger {
  private readonly started = new Map<string, string>();
  private readonly successful = new Map<string, ExecutionFact>();

  seed(capabilityId: string, factId = `seed:${capabilityId}`): void {
    const normalized = capabilityId.trim();
    if (!normalized) return;
    this.successful.set(factId, {
      toolCallId: factId,
      toolName: "system",
      capabilityIds: [normalized],
      completedAt: new Date().toISOString(),
    });
  }

  record(event: AgentRuntimeEvent): void {
    if (event.type === "tool_started") {
      const callId = event.toolCallId?.trim();
      if (callId) this.started.set(callId, event.toolName);
      return;
    }
    if (event.type !== "tool_completed" || event.isError === true) return;

    const callId = event.toolCallId?.trim();
    const toolName = event.toolName?.trim() || (callId ? this.started.get(callId) : undefined);
    if (!toolName) return;
    const resolvedId = callId || `completed:${normalizeToolName(toolName)}:${this.successful.size + 1}`;
    this.successful.set(resolvedId, {
      toolCallId: resolvedId,
      toolName,
      capabilityIds: capabilityIdsForTool(toolName),
      completedAt: new Date().toISOString(),
    });
  }

  snapshot(): ExecutionFact[] {
    return [...this.successful.values()].map((fact) => ({
      ...fact,
      capabilityIds: [...fact.capabilityIds],
    }));
  }
}

export function evaluateExecutionRequirements(
  requirements: readonly ExecutionRequirement[],
  facts: readonly ExecutionFact[],
): ExecutionGateDecision {
  const normalizedRequirements = requirements
    .map((requirement) => ({
      ...requirement,
      anyOf: [...new Set(requirement.anyOf.map((item) => item.trim()).filter(Boolean))],
      minimumCount: Math.max(1, requirement.minimumCount ?? 1),
    }))
    .filter((requirement) => requirement.anyOf.length > 0);
  const observedCapabilityIds = [...new Set(facts.flatMap((fact) => fact.capabilityIds))].sort();
  const missing = normalizedRequirements.flatMap((requirement) => {
    const observedCount = facts.filter((fact) =>
      requirement.anyOf.some((capabilityId) => fact.capabilityIds.includes(capabilityId))
    ).length;
    return observedCount >= requirement.minimumCount
      ? []
      : [{
          id: requirement.id,
          ...(requirement.description ? { description: requirement.description } : {}),
          anyOf: requirement.anyOf,
          observedCount,
          requiredCount: requirement.minimumCount,
        }];
  });
  const fingerprintPayload = JSON.stringify({
    requirements: normalizedRequirements.map((item) => ({
      id: item.id,
      anyOf: item.anyOf,
      minimumCount: item.minimumCount,
    })),
    facts: facts.map((fact) => ({ toolCallId: fact.toolCallId, capabilityIds: fact.capabilityIds })).sort((a, b) =>
      a.toolCallId.localeCompare(b.toolCallId)
    ),
  });
  const diagnosticFingerprint = createHash("sha256").update(fingerprintPayload).digest("hex");
  if (!missing.length) {
    return { ok: true, observedCapabilityIds, diagnosticFingerprint };
  }
  const details = missing.map((item) => {
    const label = item.description?.trim() || item.id;
    return `${label}（需成功执行 ${item.requiredCount} 次；可用：${item.anyOf.join(" / ")}；当前 ${item.observedCount} 次）`;
  });
  return {
    ok: false,
    missing,
    observedCapabilityIds,
    message: `缺少可验证的能力执行事实：${details.join("；")}`,
    diagnosticFingerprint,
  };
}

/** 成功写出用户可见文件后，完成态必须由声明式交付合同和验证证据收口。 */
export function hasSuccessfulArtifactWrite(facts: readonly ExecutionFact[]): boolean {
  return facts.some((fact) =>
    fact.capabilityIds.includes("spreadsheet.write")
    || fact.capabilityIds.includes("document.write")
  );
}

export function executionRequirementsForSpreadsheetTask(input: {
  hasSpreadsheet: boolean;
  needsWrite: boolean;
  needsValidation: boolean;
}): ExecutionRequirement[] {
  if (!input.hasSpreadsheet) return [];
  return [
    {
      id: "spreadsheet.read",
      description: "读取并理解表格",
      anyOf: ["spreadsheet.read"],
    },
    ...(input.needsWrite
      ? [{ id: "spreadsheet.write", description: "受控写入工作簿", anyOf: ["spreadsheet.write"] }]
      : []),
    ...(input.needsValidation
      ? [{ id: "spreadsheet.validate", description: "确定性验证工作簿", anyOf: ["spreadsheet.validate"] }]
      : []),
  ];
}

export function executionRequirementsFromToolGroups(
  groups: readonly string[],
): ExecutionRequirement[] {
  return groups.map((group, index) => {
    const tools = group.split("|").map(normalizeToolName).filter(Boolean);
    return {
      id: `expected-tool-${index + 1}`,
      description: `执行期望工具 ${tools.join(" 或 ")}`,
      anyOf: tools,
    };
  }).filter((requirement) => requirement.anyOf.length > 0);
}
