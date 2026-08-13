import type { DatabaseSync } from "node:sqlite";
import { sha256Json } from "@/lib/capability/hash";
import { PrincipalRefSchema, type PrincipalRef } from "@/lib/capability/common";

export class RetrievalAccessController {
  constructor(readonly db: DatabaseSync) {}

  grant(documentId: string, principalValue: PrincipalRef, at: string): void {
    const principal = PrincipalRefSchema.parse(principalValue);
    this.db.prepare(`
      INSERT INTO retrieval_document_acl(document_id, principal_type, principal_id, tenant_id, granted_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(document_id, principal_type, principal_id, tenant_id) DO UPDATE SET
        granted_at=excluded.granted_at, revoked_at=NULL
    `).run(documentId, principal.type, principal.id, principal.tenantId ?? "", at);
    this.bumpRevision(documentId, at);
  }

  revoke(documentId: string, principalValue: PrincipalRef, at: string): void {
    const principal = PrincipalRefSchema.parse(principalValue);
    const result = this.db.prepare(`
      UPDATE retrieval_document_acl SET revoked_at=?
      WHERE document_id=? AND principal_type=? AND principal_id=? AND tenant_id=? AND revoked_at IS NULL
    `).run(at, documentId, principal.type, principal.id, principal.tenantId ?? "");
    if (result.changes > 0) this.bumpRevision(documentId, at);
  }

  canRead(documentId: string, principalValue: PrincipalRef): boolean {
    const principal = PrincipalRefSchema.parse(principalValue);
    return Boolean(this.db.prepare(`
      SELECT 1 FROM retrieval_document_acl
      WHERE document_id=? AND principal_type=? AND principal_id=? AND tenant_id=? AND revoked_at IS NULL
      LIMIT 1
    `).get(documentId, principal.type, principal.id, principal.tenantId ?? ""));
  }

  permissionFingerprint(principalValue: PrincipalRef): string {
    const principal = PrincipalRefSchema.parse(principalValue);
    const rows = this.db.prepare(`
      SELECT d.document_id, d.permission_revision
      FROM retrieval_documents d
      JOIN retrieval_document_acl a ON a.document_id=d.document_id
      WHERE a.principal_type=? AND a.principal_id=? AND a.tenant_id=? AND a.revoked_at IS NULL
      ORDER BY d.document_id
    `).all(principal.type, principal.id, principal.tenantId ?? "") as Array<{ document_id: string; permission_revision: number }>;
    return sha256Json(rows);
  }

  private bumpRevision(documentId: string, at: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE retrieval_documents SET permission_revision=permission_revision+1, updated_at=? WHERE document_id=?
      `).run(at, documentId);
      this.db.prepare("DELETE FROM retrieval_query_cache").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
