import type { DatabaseSync } from "node:sqlite";
import { z } from "zod/v4";
import type { AgentRunContext } from "@/lib/agent/contracts";
import { CapabilityExecutor, CapabilityExecutionError } from "@/lib/capability/executor";
import type { CapabilityDefinition } from "@/lib/capability/contracts";
import { CapabilityRegistry } from "@/lib/capability/registry";
import { getDb } from "@/lib/db/sqlite";
import { LedgerExecutionGovernor, ResourceLedger } from "@/lib/resource/ledger";
import { JsonValueSchema } from "@/lib/capability/common";
import { actionsForCapability, createCapabilitySecurityGuard } from "@/lib/security/capability-guard";
import { SecurityAuthorizer } from "@/lib/security/kernel";
import { ensureTaskCapabilityGrant, ensureTaskEgressGrant } from "@/lib/security/session-grants";
import type { FinanceToolDefinition } from "./finance-definition";
import {
  assertFinanceCapabilityPoliciesFor,
  assertFinanceCapabilityPolicyCoverage,
  resolveFinanceCapabilityPolicy,
} from "./capability-policy";

export type FinanceCapabilityRuntimeContext = {
  runId: string;
  caseId?: string;
  runContext?: AgentRunContext;
};

export type FinanceToolRuntime = {
  execute(
    definition: FinanceToolDefinition,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type RuntimeDependencies = {
  db?: DatabaseSync;
};

export type FinanceCapabilityCatalogSyncResult = {
  available: number;
  deprecated: string[];
};

const CAPABILITY_VERSION = "1";
const GLOBAL_CONCURRENCY = 4;
const FINANCE_OUTPUT_VALIDATOR = "finance_tool.serializable_output";
const FinanceToolOutputSchema = z.object({
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().min(1) }).passthrough(),
  ])).min(1),
  structuredContent: JsonValueSchema.optional(),
  isError: z.boolean().optional(),
}).passthrough();
type FinanceToolOutput = z.infer<typeof FinanceToolOutputSchema>;

/**
 * Post-authorization execution boundary for the production finance catalog.
 *
 * The existing FinanceToolAuthorizer remains the policy/confirmation authority
 * and is always called before this runtime by the Pi adapter. CapabilityExecutor
 * is the sole production authority and invokes the registered tool handler once,
 * with attempts, resource leases and structured failures around it.
 */
export class FinanceCapabilityRuntime implements FinanceToolRuntime {
  readonly registry: CapabilityRegistry;
  readonly executor: CapabilityExecutor;
  private readonly securityGuard?: ReturnType<typeof createCapabilitySecurityGuard>;

  constructor(
    readonly definitions: FinanceToolDefinition[],
    readonly context: FinanceCapabilityRuntimeContext,
    dependencies: RuntimeDependencies = {},
  ) {
    assertFinanceCapabilityPolicyCoverage();
    assertFinanceCapabilityPoliciesFor(definitions.map((definition) => definition.id));
    const db = dependencies.db ?? getDb();
    const ledger = new ResourceLedger(db);
    ensureResourceBudgets(db, ledger, context);
    this.registry = new CapabilityRegistry(db);
    if (context.runContext) {
      const authorizer = new SecurityAuthorizer(db);
      const destinationDomain = configuredResearchGatewayDomain();
      this.securityGuard = createCapabilitySecurityGuard(authorizer, {
        principal: context.runContext.principal,
        tenantId: context.runContext.tenantId,
        caseId: context.runContext.caseId,
        classification: context.runContext.security.classification,
        destinationDomain: (definition) =>
          definition.id === capabilityId("research_web") ? destinationDomain : undefined,
      });
    }
    this.executor = new CapabilityExecutor(
      this.registry,
      // The task-scoped security decision is enforced before the single
      // production executor. The Pi authorizer remains the human confirmation
      // boundary for high-risk operations.
      [],
      new LedgerExecutionGovernor(ledger),
    );
    for (const definition of definitions) registerFinanceCapabilityDefinition(this.registry, definition);
    if (context.runContext) this.bootstrapTaskGrants(db, context.runContext);
  }

  async execute(
    definition: FinanceToolDefinition,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.securityGuard) {
      const capability = this.registry.resolve(capabilityId(definition.id), CAPABILITY_VERSION);
      if (!capability) throw new Error(`Capability ${definition.id} is not registered`);
      const denied = await this.securityGuard(capability, args);
      if (denied) throw new CapabilityExecutionError(denied);
    }
    const result = await this.executor.execute({
      capabilityId: capabilityId(definition.id),
      version: CAPABILITY_VERSION,
      input: args,
      runId: this.context.runId,
      ...(this.context.caseId ? { caseId: this.context.caseId } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!result.ok) throw new CapabilityExecutionError(result.failure);
    return result.output;
  }

  private bootstrapTaskGrants(db: DatabaseSync, runContext: AgentRunContext): void {
    const authorizer = new SecurityAuthorizer(db);
    const expiresAt = new Date(Date.now() + (runContext.budget.wallTimeMs ?? 4 * 60 * 60 * 1_000)).toISOString();
    for (const definition of this.definitions) {
      const capability = this.registry.resolve(capabilityId(definition.id), CAPABILITY_VERSION);
      if (!capability) throw new Error(`Capability ${definition.id} is not registered`);
      const actions = actionsForCapability(capability);
      // A denied network capability may remain visible in the catalog so the
      // execution guard can fail it closed when selected. Do not fail the
      // entire Agent while bootstrapping an otherwise local task, and never
      // pre-grant the denied network action.
      const grantableActions = runContext.security.allowExternalEgress
        ? actions
        : actions.filter((action) => action !== "network");
      if (grantableActions.length) {
        ensureTaskCapabilityGrant(authorizer, {
          principal: runContext.principal,
          tenantId: runContext.tenantId,
          caseId: runContext.caseId,
          capabilityId: capability.id,
          actions: grantableActions,
          expiresAt,
        });
      }
      if (actions.includes("network")) {
        if (!runContext.security.allowExternalEgress) continue;
        for (const domain of runContext.security.allowedDomains) {
          ensureTaskEgressGrant(authorizer, {
            principal: runContext.principal,
            tenantId: runContext.tenantId,
            caseId: runContext.caseId,
            capabilityId: capability.id,
            domain,
            expiresAt,
          });
        }
      }
    }
  }
}

/**
 * Reconciles the persisted management catalog with the production definitions.
 *
 * This is deliberately separate from FinanceCapabilityRuntime: startup catalog
 * discovery must not allocate a synthetic run budget, create grants or execute
 * any tool. Removed definitions are retained as deprecated audit records.
 */
export function synchronizeFinanceCapabilityCatalog(
  definitions: FinanceToolDefinition[],
  dependencies: RuntimeDependencies = {},
): FinanceCapabilityCatalogSyncResult {
  assertFinanceCapabilityPolicyCoverage();
  assertFinanceCapabilityPoliciesFor(definitions.map((definition) => definition.id));
  const db = dependencies.db ?? getDb();
  const registry = new CapabilityRegistry(db);
  for (const definition of definitions) registerFinanceCapabilityDefinition(registry, definition);

  const currentIds = new Set(definitions.map((definition) => capabilityId(definition.id)));
  const ownedRows = db.prepare(`
    SELECT DISTINCT d.capability_id
    FROM capability_definitions d
    JOIN capability_instances i
      ON i.capability_id = d.capability_id AND i.version = d.version
    WHERE d.capability_id LIKE 'finance-tool.%'
      AND i.provider_id IN ('finance_worker', 'kingdee_worker')
  `).all() as Array<{ capability_id: string }>;
  const deprecated = ownedRows
    .map((row) => row.capability_id)
    .filter((id) => !currentIds.has(id))
    .sort();

  if (deprecated.length > 0) {
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      const deprecateDefinition = db.prepare(`
        UPDATE capability_definitions
        SET status='deprecated', unavailable_reason=NULL, updated_at=?
        WHERE capability_id=? AND version=?
      `);
      const retireInstance = db.prepare(`
        UPDATE capability_instances
        SET status='unavailable', checked_at=?
        WHERE capability_id=? AND version=?
          AND provider_id IN ('finance_worker', 'kingdee_worker')
      `);
      for (const id of deprecated) {
        deprecateDefinition.run(now, id, CAPABILITY_VERSION);
        retireInstance.run(now, id, CAPABILITY_VERSION);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return { available: currentIds.size, deprecated };
}

function registerFinanceCapabilityDefinition(
  registry: CapabilityRegistry,
  definition: FinanceToolDefinition,
): void {
  const policy = resolveFinanceCapabilityPolicy(definition.id);
  const inputSchema = z.object(definition.schema);
  const capability: CapabilityDefinition<Record<string, unknown>, z.infer<typeof FinanceToolOutputSchema>> = {
      id: capabilityId(definition.id),
      version: CAPABILITY_VERSION,
      title: definition.name,
      inputSchemaId: `finance-tool.${definition.id}.input.v1`,
      outputSchemaId: `finance-tool.${definition.id}.output.v1`,
      preconditions: [{
        id: "tool_authorization_succeeded",
        description: "The finance tool authorization and confirmation boundary completed successfully",
        blocking: true,
      }],
      sideEffects: policy.sideEffects,
      requiredPermissions: policy.requiredPermissions,
      evidenceProduced: policy.evidenceProduced,
      resourceEstimate: estimateFor(definition),
      validators: [{ id: FINANCE_OUTPUT_VALIDATOR, version: "1", blocking: true }],
      failureSemantics: {
        declaredKinds: [
          "invalid_input",
          "dependency_unavailable",
          "permission_denied",
          "policy_blocked",
          "resource_exhausted",
          "human_decision_required",
          "canceled",
          "internal_error",
        ],
        retryableKinds: [],
        maxAttempts: 1,
        backoffMs: 0,
      },
      idempotency: policy.idempotency,
      metadata: {
        toolId: definition.id,
        namespace: definition.namespace,
        riskLevel: definition.riskLevel,
        authorizationBoundary: "finance_tool_authorizer",
      },
      inputSchema,
      outputSchema: FinanceToolOutputSchema,
      validatorHandlers: {
        [FINANCE_OUTPUT_VALIDATOR]: (output) => {
          const serialized = JSON.stringify(output);
          if (!serialized) throw new Error("Finance tool output is not JSON serializable");
          if (Buffer.byteLength(serialized) > estimateFor(definition).expectedToolOutputBytes) {
            throw new Error("Finance tool output exceeds its declared output budget");
          }
        },
      },
      handler: async (input, execution) =>
        normalizeOutput(await definition.handler(input, { signal: execution.signal })),
    };
  registry.register(capability, {
    aliases: [definition.id],
    providerId: definition.namespace,
  });
}

export function createFinanceCapabilityRuntime(
  definitions: FinanceToolDefinition[],
  context: FinanceCapabilityRuntimeContext,
  dependencies: RuntimeDependencies = {},
): FinanceCapabilityRuntime {
  if (!context.runId.trim()) throw new Error("Finance Capability runtime requires runId");
  return new FinanceCapabilityRuntime(definitions, context, dependencies);
}

function capabilityId(toolId: string): string {
  return `finance-tool.${toolId}`;
}

function normalizeOutput(output: unknown): FinanceToolOutput {
  return FinanceToolOutputSchema.parse(output);
}

function estimateFor(definition: FinanceToolDefinition) {
  const network = resolveFinanceCapabilityPolicy(definition.id).sideEffects.some(
    (effect) => effect.kind === "network",
  );
  if (definition.riskLevel === "high") {
    return {
      expectedWallTimeMs: 180_000,
      expectedMemoryBytes: 512 * 1024 * 1024,
      expectedDiskBytes: 512 * 1024 * 1024,
      expectedNetworkBytes: network ? 128 * 1024 * 1024 : 0,
      expectedToolOutputBytes: 16 * 1024 * 1024,
      confidence: 0.5,
    };
  }
  if (definition.riskLevel === "medium") {
    return {
      expectedWallTimeMs: 90_000,
      expectedMemoryBytes: 256 * 1024 * 1024,
      expectedDiskBytes: 128 * 1024 * 1024,
      expectedNetworkBytes: network ? 64 * 1024 * 1024 : 0,
      expectedToolOutputBytes: 8 * 1024 * 1024,
      confidence: 0.5,
    };
  }
  return {
    expectedWallTimeMs: 30_000,
    expectedMemoryBytes: 64 * 1024 * 1024,
    expectedDiskBytes: 10 * 1024 * 1024,
    expectedNetworkBytes: network ? 10 * 1024 * 1024 : 0,
    expectedToolOutputBytes: 2 * 1024 * 1024,
    confidence: 0.6,
  };
}

function ensureResourceBudgets(
  db: DatabaseSync,
  ledger: ResourceLedger,
  context: FinanceCapabilityRuntimeContext,
): void {
  const existing = db.prepare(`
    SELECT 1 FROM resource_budget_scopes
    WHERE scope_type='global' AND scope_key='default'
  `).get();
  if (!existing) {
    ledger.setBudget({ type: "global", key: "default" }, {
      tokenLimit: null,
      wallTimeMs: null,
      cpuTimeMs: null,
      memoryBytes: null,
      diskBytes: null,
      networkBytes: null,
      toolOutputBytes: null,
      concurrency: GLOBAL_CONCURRENCY,
      retryLimit: 0,
    });
  }
  const runBudget = context.runContext?.budget ?? {
    tokenLimit: 500_000,
    wallTimeMs: 4 * 60 * 60 * 1_000,
    cpuTimeMs: 2 * 60 * 60 * 1_000,
    memoryBytes: 1024 * 1024 * 1024,
    diskBytes: 2 * 1024 * 1024 * 1024,
    networkBytes: 256 * 1024 * 1024,
    toolOutputBytes: 64 * 1024 * 1024,
    concurrency: 2,
    retryLimit: 0,
  };
  ledger.setBudget({ type: "run", key: context.runId }, runBudget);
  if (context.caseId) ledger.setBudget({ type: "case", key: context.caseId }, runBudget);
}

function configuredResearchGatewayDomain(): string | undefined {
  const endpoint = process.env.FINWORK_RESEARCH_GATEWAY_URL?.trim();
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
