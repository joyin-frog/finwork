import type { DatabaseSync } from "node:sqlite";
import { CapabilityManifestSchema, type CapabilityDefinition, type CapabilityFailure } from "./contracts";
import { canonicalJson, sha256Json } from "./hash";

export type CapabilityAvailability = "available" | "unavailable" | "deprecated";

export type CapabilityRegistration = {
  aliases?: string[];
  status?: CapabilityAvailability;
  unavailableReason?: string;
  providerId?: string;
};

export type CapabilityPreflight = (
  definition: CapabilityDefinition,
) => Promise<CapabilityFailure | null> | CapabilityFailure | null;

function definitionKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export class CapabilityRegistry {
  readonly #definitions = new Map<string, CapabilityDefinition>();
  readonly #preflight = new Map<string, CapabilityPreflight>();

  constructor(readonly db: DatabaseSync) {}

  register<I, O>(
    rawDefinition: CapabilityDefinition<I, O>,
    registration: CapabilityRegistration = {},
    preflight?: CapabilityPreflight,
  ): CapabilityDefinition<I, O> {
    const { inputSchema, outputSchema, handler, validatorHandlers, ...rawManifest } = rawDefinition;
    const manifest = CapabilityManifestSchema.parse(rawManifest);
    for (const validator of manifest.validators) {
      if (validator.blocking && !validatorHandlers?.[validator.id]) {
        throw new Error(
          `blocking validator ${validator.id}@${validator.version} has no runtime implementation for ${manifest.id}@${manifest.version}`,
        );
      }
    }
    const definition = {
      ...manifest,
      inputSchema,
      outputSchema,
      handler,
      ...(validatorHandlers ? { validatorHandlers } : {}),
    } as CapabilityDefinition<I, O>;
    const status = registration.status ?? "available";
    const unavailableReason = registration.unavailableReason?.trim() || null;
    if (status === "unavailable" && !unavailableReason) {
      throw new Error(`unavailable capability ${manifest.id}@${manifest.version} requires a reason`);
    }
    if (status !== "unavailable" && unavailableReason) {
      throw new Error("unavailableReason is only valid for unavailable capabilities");
    }

    const checksum = sha256Json(manifest);
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO capability_definitions
          (capability_id, version, title, input_schema_id, output_schema_id, manifest_json,
           checksum, status, unavailable_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(capability_id, version) DO UPDATE SET
          title=excluded.title,
          input_schema_id=excluded.input_schema_id,
          output_schema_id=excluded.output_schema_id,
          manifest_json=excluded.manifest_json,
          checksum=excluded.checksum,
          status=excluded.status,
          unavailable_reason=excluded.unavailable_reason,
          updated_at=excluded.updated_at
      `).run(
        manifest.id,
        manifest.version,
        manifest.title,
        manifest.inputSchemaId,
        manifest.outputSchemaId,
        canonicalJson(manifest),
        checksum,
        status,
        unavailableReason,
        now,
        now,
      );
      for (const alias of registration.aliases ?? []) {
        const normalized = alias.trim();
        if (!normalized) throw new Error("capability alias cannot be empty");
        const existing = this.db.prepare(
          "SELECT capability_id, version FROM capability_aliases WHERE alias = ?",
        ).get(normalized) as { capability_id: string; version: string } | undefined;
        if (existing && (existing.capability_id !== manifest.id || existing.version !== manifest.version)) {
          throw new Error(`capability alias collision: ${normalized}`);
        }
        this.db.prepare(`
          INSERT INTO capability_aliases(alias, capability_id, version, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(alias) DO NOTHING
        `).run(normalized, manifest.id, manifest.version, now);
      }
      if (registration.providerId) {
        const instanceId = `${registration.providerId}:${manifest.id}@${manifest.version}`;
        this.db.prepare(`
          INSERT INTO capability_instances
            (instance_id, capability_id, version, provider_id, status, checked_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(instance_id) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at
        `).run(
          instanceId,
          manifest.id,
          manifest.version,
          registration.providerId,
          status === "available" ? "available" : "unavailable",
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const key = definitionKey(manifest.id, manifest.version);
    this.#definitions.set(key, definition as CapabilityDefinition);
    if (preflight) this.#preflight.set(key, preflight);
    return definition;
  }

  resolve(idOrAlias: string, version?: string): CapabilityDefinition | null {
    let capabilityId = idOrAlias;
    let resolvedVersion = version;
    if (!resolvedVersion) {
      const alias = this.db.prepare(
        "SELECT capability_id, version FROM capability_aliases WHERE alias = ?",
      ).get(idOrAlias) as { capability_id: string; version: string } | undefined;
      if (alias) {
        capabilityId = alias.capability_id;
        resolvedVersion = alias.version;
      }
    }
    if (!resolvedVersion) {
      const row = this.db.prepare(`
        SELECT version FROM capability_definitions
        WHERE capability_id = ? AND status = 'available'
        ORDER BY created_at DESC, version DESC LIMIT 1
      `).get(capabilityId) as { version: string } | undefined;
      resolvedVersion = row?.version;
    }
    if (!resolvedVersion) return null;
    const row = this.db.prepare(`
      SELECT status FROM capability_definitions WHERE capability_id = ? AND version = ?
    `).get(capabilityId, resolvedVersion) as { status: CapabilityAvailability } | undefined;
    if (!row || row.status !== "available") return null;
    return this.#definitions.get(definitionKey(capabilityId, resolvedVersion)) ?? null;
  }

  inspect(id: string, version: string): { status: CapabilityAvailability; unavailableReason: string | null } | null {
    const row = this.db.prepare(`
      SELECT status, unavailable_reason FROM capability_definitions
      WHERE capability_id = ? AND version = ?
    `).get(id, version) as { status: CapabilityAvailability; unavailable_reason: string | null } | undefined;
    return row ? { status: row.status, unavailableReason: row.unavailable_reason } : null;
  }

  async preflight(definition: CapabilityDefinition): Promise<CapabilityFailure | null> {
    const check = this.#preflight.get(definitionKey(definition.id, definition.version));
    return check ? await check(definition) : null;
  }

  list(): Array<{ id: string; version: string; status: CapabilityAvailability; reason: string | null }> {
    return (this.db.prepare(`
      SELECT capability_id, version, status, unavailable_reason
      FROM capability_definitions ORDER BY capability_id, version
    `).all() as Array<{
      capability_id: string;
      version: string;
      status: CapabilityAvailability;
      unavailable_reason: string | null;
    }>).map((row) => ({
      id: row.capability_id,
      version: row.version,
      status: row.status,
      reason: row.unavailable_reason,
    }));
  }
}
