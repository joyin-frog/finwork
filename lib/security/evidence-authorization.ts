import type { PrincipalRef } from "@/lib/capability/common";
import type { DataClassification, SecurityTaint } from "./contracts";
import { SecurityAuthorizer } from "./kernel";

/**
 * Produces the exact, persisted authorization decision referenced by an
 * EvidenceRecord. Callers must provision authority separately; this helper
 * never self-grants and therefore cannot turn a write into its own permission.
 */
export function authorizeEvidenceWrite(input: {
  authorizer: SecurityAuthorizer;
  principal: PrincipalRef;
  tenantId: string;
  caseId: string;
  capabilityId: string;
  artifactVersionId: string;
  classification: DataClassification;
  taints?: SecurityTaint[];
  now: string;
}): string {
  return input.authorizer.authorizeOrThrow({
    principal: input.principal,
    tenantId: input.tenantId,
    caseId: input.caseId,
    capabilityId: input.capabilityId,
    action: "write",
    artifactVersionId: input.artifactVersionId,
    classification: input.classification,
    taints: input.taints ?? [],
    now: input.now,
  }).id;
}
