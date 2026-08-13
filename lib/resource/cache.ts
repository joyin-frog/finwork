import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";

export type CacheDescriptor = { namespace: string; inputHash: string; toolVersion: string; policyRevision: string; authorizationHash: string };
export class IncrementalCache {
  constructor(readonly db: DatabaseSync, readonly maxBytes: number) {}
  key(descriptor: CacheDescriptor): string { return createHash("sha256").update(canonicalJson(descriptor)).digest("hex"); }
  get<T>(descriptor: CacheDescriptor, now = new Date().toISOString()): T | null {
    const key = this.key(descriptor);
    const row = this.db.prepare(`SELECT value_json,authorization_hash,expires_at FROM incremental_cache_entries WHERE cache_key=?`).get(key) as { value_json: string | null; authorization_hash: string; expires_at: string | null } | undefined;
    if (!row || row.authorization_hash !== descriptor.authorizationHash || (row.expires_at && row.expires_at <= now) || row.value_json == null) return null;
    this.db.prepare("UPDATE incremental_cache_entries SET accessed_at=?,hit_count=hit_count+1 WHERE cache_key=?").run(now, key);
    return JSON.parse(row.value_json) as T;
  }
  set(descriptor: CacheDescriptor, value: unknown, artifactVersionId?: string, ttlMs?: number, now = new Date().toISOString()): string {
    const key = this.key(descriptor); const json = canonicalJson(value); const bytes = Buffer.byteLength(json); if (bytes > this.maxBytes) throw new Error("cache entry exceeds cache budget");
    const expires = ttlMs == null ? null : new Date(Date.parse(now) + ttlMs).toISOString();
    this.db.prepare(`INSERT INTO incremental_cache_entries(cache_key,namespace,artifact_version_id,value_json,size_bytes,authorization_hash,created_at,accessed_at,expires_at,hit_count) VALUES (?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(cache_key) DO UPDATE SET artifact_version_id=excluded.artifact_version_id,value_json=excluded.value_json,size_bytes=excluded.size_bytes,authorization_hash=excluded.authorization_hash,accessed_at=excluded.accessed_at,expires_at=excluded.expires_at`).run(key, descriptor.namespace, artifactVersionId ?? null, json, bytes, descriptor.authorizationHash, now, now, expires);
    this.evict(now); return key;
  }
  evict(now = new Date().toISOString()): { entries: number; bytes: number } {
    const expired = this.db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(size_bytes),0) AS bytes FROM incremental_cache_entries WHERE expires_at IS NOT NULL AND expires_at<=?").get(now) as { n: number; bytes: number };
    this.db.prepare("DELETE FROM incremental_cache_entries WHERE expires_at IS NOT NULL AND expires_at<=?").run(now);
    let total = Number((this.db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM incremental_cache_entries").get() as { n: number }).n); let entries = expired.n; let bytes = expired.bytes;
    const rows = this.db.prepare("SELECT cache_key,size_bytes FROM incremental_cache_entries ORDER BY accessed_at ASC").all() as Array<{ cache_key: string; size_bytes: number }>;
    for (const row of rows) { if (total <= this.maxBytes) break; this.db.prepare("DELETE FROM incremental_cache_entries WHERE cache_key=?").run(row.cache_key); total -= row.size_bytes; entries++; bytes += row.size_bytes; }
    return { entries, bytes };
  }
  stats(): { entries: number; bytes: number; hits: number } { return this.db.prepare("SELECT COUNT(*) AS entries,COALESCE(SUM(size_bytes),0) AS bytes,COALESCE(SUM(hit_count),0) AS hits FROM incremental_cache_entries").get() as { entries: number; bytes: number; hits: number }; }
}
