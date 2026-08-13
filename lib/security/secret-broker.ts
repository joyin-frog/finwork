import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { PrincipalRefSchema, type PrincipalRef } from "@/lib/capability/common";
import { SecretLeaseSchema, type SecretLease } from "./contracts";
import { SecurityAuditLedger } from "./audit";

type LeaseRow = {
  secret_id: string;
  principal_json: string;
  capability_id: string;
  destination_domain: string;
  expires_at: string;
  remaining_uses: number;
  revoked_at: string | null;
  created_at: string;
};

export interface SecretMaterialBackend {
  get(secretId: string): string | null;
}

export class InMemorySecretBackend implements SecretMaterialBackend {
  readonly #values = new Map<string, string>();
  register(secretId: string, value: string): void {
    if (!value) throw new Error("secret value cannot be empty");
    this.#values.set(secretId, value);
  }
  get(secretId: string): string | null { return this.#values.get(secretId) ?? null; }
}

export class SecretBroker {
  readonly audit: SecurityAuditLedger;
  constructor(
    readonly db: DatabaseSync,
    readonly backend: SecretMaterialBackend,
    audit = new SecurityAuditLedger(db),
  ) { this.audit = audit; }

  issueLease(input: {
    secretId: string;
    principal: PrincipalRef;
    capabilityId: string;
    destinationDomain: string;
    ttlMs: number;
    maxUses: number;
    now: string;
  }): SecretLease {
    if (!this.backend.get(input.secretId)) throw new Error(`secret not found: ${input.secretId}`);
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1) throw new Error("maxUses must be a positive integer");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new Error("ttlMs must be positive");
    const principal = PrincipalRefSchema.parse(input.principal);
    const lease = SecretLeaseSchema.parse({
      id: randomUUID(), secretId: input.secretId, principal, capabilityId: input.capabilityId,
      destinationDomain: input.destinationDomain.toLowerCase(),
      expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
      remainingUses: input.maxUses, createdAt: input.now,
    });
    this.db.prepare(`INSERT INTO secret_leases
      (lease_id, secret_id, principal_json, capability_id, destination_domain, expires_at, remaining_uses, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lease.id, lease.secretId, canonicalJson(lease.principal), lease.capabilityId,
        lease.destinationDomain, lease.expiresAt, lease.remainingUses, lease.createdAt);
    this.audit.append({ eventType: "secret_lease_issued", principal, tenantId: principal.tenantId ?? "default",
      capabilityId: lease.capabilityId, payload: { leaseId: lease.id, secretId: lease.secretId,
        destinationDomain: lease.destinationDomain, maxUses: lease.remainingUses, expiresAt: lease.expiresAt }, at: input.now });
    return lease;
  }

  use<T>(leaseId: string, context: {
    principal: PrincipalRef; capabilityId: string; destinationDomain: string; now: string;
  }, operation: (secret: string) => T): T {
    const row = this.db.prepare("SELECT * FROM secret_leases WHERE lease_id = ?").get(leaseId) as LeaseRow | undefined;
    if (!row) throw new Error("secret lease not found");
    const leasePrincipal = PrincipalRefSchema.parse(JSON.parse(row.principal_json));
    if (canonicalJson(leasePrincipal) !== canonicalJson(PrincipalRefSchema.parse(context.principal))) throw new Error("secret lease principal mismatch");
    if (row.capability_id !== context.capabilityId) throw new Error("secret lease capability mismatch");
    if (row.destination_domain !== context.destinationDomain.toLowerCase()) throw new Error("secret lease destination mismatch");
    if (row.revoked_at) throw new Error("secret lease revoked");
    if (row.expires_at <= context.now) throw new Error("secret lease expired");
    if (row.remaining_uses < 1) throw new Error("secret lease exhausted");
    const material = this.backend.get(row.secret_id);
    if (!material) throw new Error("secret material unavailable");
    this.db.prepare("UPDATE secret_leases SET remaining_uses = remaining_uses - 1 WHERE lease_id = ?").run(leaseId);
    this.audit.append({ eventType: "secret_lease_used", principal: context.principal,
      tenantId: context.principal.tenantId ?? "default", capabilityId: context.capabilityId,
      payload: { leaseId, secretId: row.secret_id, destinationDomain: row.destination_domain }, at: context.now });
    return operation(material);
  }

  revoke(leaseId: string, principal: PrincipalRef, at: string): void {
    this.db.prepare("UPDATE secret_leases SET revoked_at = ? WHERE lease_id = ? AND revoked_at IS NULL").run(at, leaseId);
    this.audit.append({ eventType: "secret_lease_revoked", principal, tenantId: principal.tenantId ?? "default",
      payload: { leaseId }, at });
  }
}
