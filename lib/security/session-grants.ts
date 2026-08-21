import { randomUUID } from "node:crypto";
import type { PrincipalRef } from "@/lib/capability/common";
import type { SecurityAction } from "./contracts";
import { SecurityAuthorizer } from "./kernel";

type GrantScope = {
  principal: PrincipalRef;
  tenantId: string;
  caseId: string;
  capabilityId: string;
  expiresAt: string;
  now?: string;
};

/**
 * Idempotently installs the exact, task-scoped authority decided by the task
 * contract. Capability execution only consumes these grants; it never widens
 * them while a tool is running.
 */
export function ensureTaskCapabilityGrant(
  authorizer: SecurityAuthorizer,
  scope: GrantScope & { actions: SecurityAction[] },
): string {
  const now = scope.now ?? new Date().toISOString();
  const rows = authorizer.db.prepare(`
    SELECT grant_id, actions_json
    FROM security_acl_grants
    WHERE principal_id=? AND principal_type=? AND tenant_id=? AND case_id=?
      AND capability_id=? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>?)
  `).all(
    scope.principal.id,
    scope.principal.type,
    scope.tenantId,
    scope.caseId,
    scope.capabilityId,
    now,
  ) as Array<{ grant_id: string; actions_json: string }>;
  const required = new Set(scope.actions);
  const existing = rows.find((row) => {
    const actions = new Set(JSON.parse(row.actions_json) as SecurityAction[]);
    return [...required].every((action) => actions.has(action));
  });
  if (existing) return existing.grant_id;
  const grant = authorizer.grant({
    id: randomUUID(),
    principal: scope.principal,
    tenantId: scope.tenantId,
    caseId: scope.caseId,
    capabilityId: scope.capabilityId,
    actions: [...required],
    expiresAt: scope.expiresAt,
    createdAt: now,
  });
  return grant.id;
}

export function ensureTaskEgressGrant(
  authorizer: SecurityAuthorizer,
  scope: GrantScope & { domain: string },
): string {
  const now = scope.now ?? new Date().toISOString();
  const domain = scope.domain.trim().toLowerCase();
  const row = authorizer.db.prepare(`
    SELECT grant_id
    FROM security_egress_grants
    WHERE principal_id=? AND tenant_id=? AND case_id=? AND capability_id=?
      AND domain=? AND revoked_at IS NULL AND expires_at>?
    LIMIT 1
  `).get(
    scope.principal.id,
    scope.tenantId,
    scope.caseId,
    scope.capabilityId,
    domain,
    now,
  ) as { grant_id: string } | undefined;
  if (row) return row.grant_id;
  const grant = authorizer.grantEgress({
    id: randomUUID(),
    principal: scope.principal,
    tenantId: scope.tenantId,
    caseId: scope.caseId,
    capabilityId: scope.capabilityId,
    domain,
    expiresAt: scope.expiresAt,
    createdAt: now,
  });
  return grant.id;
}
