import type { PrincipalRef } from "@/lib/capability/common";
import type { CapabilityDefinition, CapabilityFailure } from "@/lib/capability/contracts";
import type { ExecutionGuard } from "@/lib/capability/executor";
import { SecurityActionSchema, type DataClassification, type SecurityAction, type SecurityTaint } from "./contracts";
import { SecurityAuthorizer } from "./kernel";

export type CapabilitySecurityContext = {
  principal: PrincipalRef;
  tenantId: string;
  caseId?: string;
  classification?: DataClassification;
  taints?: SecurityTaint[];
  now?: () => string;
  artifactVersionId?: (definition: CapabilityDefinition, input: unknown) => string | undefined;
  destinationDomain?: (definition: CapabilityDefinition, input: unknown) => string | undefined;
  approvalId?: (definition: CapabilityDefinition, input: unknown) => string | undefined;
};

const SIDE_EFFECT_ACTIONS: Record<CapabilityDefinition["sideEffects"][number]["kind"], SecurityAction | null> = {
  none: null,
  read: "read",
  write: "write",
  delete: "delete",
  network: "network",
  external_action: "export",
};

export function actionsForCapability(definition: CapabilityDefinition): SecurityAction[] {
  const declared = definition.requiredPermissions
    .map((permission) => SecurityActionSchema.safeParse(permission.action))
    .filter((result) => result.success)
    .map((result) => result.data);
  const effects = definition.sideEffects.map((effect) => SIDE_EFFECT_ACTIONS[effect.kind]).filter((action): action is SecurityAction => action !== null);
  return [...new Set([...declared, ...effects])];
}

function failure(decision: ReturnType<SecurityAuthorizer["authorize"]>): CapabilityFailure | null {
  if (decision.decision === "allow") return null;
  const kind = decision.decision === "require_approval"
    ? "human_decision_required"
    : ["malware_taint", "prompt_injection_capability_escalation"].includes(decision.code)
      ? "policy_blocked"
      : "permission_denied";
  return {
    kind,
    code: decision.code,
    message: decision.reason,
    retryable: false,
    details: { decisionId: decision.id, obligations: decision.obligations },
  };
}

export function createCapabilitySecurityGuard(
  authorizer: SecurityAuthorizer,
  context: CapabilitySecurityContext,
): ExecutionGuard {
  return (definition, input) => {
    const actions = actionsForCapability(definition);
    for (const action of actions) {
      const decision = authorizer.authorize({
        principal: context.principal,
        tenantId: context.tenantId,
        caseId: context.caseId,
        capabilityId: definition.id,
        action,
        artifactVersionId: context.artifactVersionId?.(definition, input),
        classification: context.classification ?? "internal",
        taints: context.taints ?? [],
        destinationDomain: context.destinationDomain?.(definition, input),
        approvalId: context.approvalId?.(definition, input),
        now: context.now?.() ?? new Date().toISOString(),
      });
      const denied = failure(decision);
      if (denied) return denied;
    }
    return null;
  };
}
