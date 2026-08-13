import type { BusinessNode, HumanDecisionRecord, RoleCapabilityView } from "./contracts";

export type RoleViewDefinition = {
  roleId: string;
  capabilityIds: string[];
  rulePackIds: string[];
  visibleKinds: BusinessNode["kind"][];
};

/** Roles are projections over shared case state; no role-owned state is copied. */
export function projectRoleView(input: {
  caseId: string;
  definition: RoleViewDefinition;
  nodes: readonly BusinessNode[];
  decisions: readonly HumanDecisionRecord[];
}): RoleCapabilityView {
  const visible = new Set(input.definition.visibleKinds);
  return {
    caseId: input.caseId,
    roleId: input.definition.roleId,
    capabilityIds: [...new Set(input.definition.capabilityIds)].sort(),
    rulePackIds: [...new Set(input.definition.rulePackIds)].sort(),
    visibleNodeIds: input.nodes.filter((node) => visible.has(node.kind)).map((node) => node.id).sort(),
    pendingDecisionIds: input.decisions.filter((decision) => decision.status === "pending").map((decision) => decision.id).sort(),
  };
}
