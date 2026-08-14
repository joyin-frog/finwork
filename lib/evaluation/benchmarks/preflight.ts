import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db/sqlite";
import { isMockAgentEnabled } from "@/lib/agent/mock-agent";
import { buildMessagesUrl } from "@/lib/agent/router";
import { checkPythonEnvironment, type PythonDoctorResult } from "@/lib/runtime/python-doctor";
import { getSpreadsheetCapabilities, type SpreadsheetCapabilities } from "@/lib/runtime/spreadsheet-probe";
import { getAppDataDir } from "@/lib/runtime/paths";
import { readAgentSettings, type AgentSettings } from "@/lib/settings/agent-settings";
import { getModelConfigReadiness } from "@/lib/settings/model-config";
import { resolveModelMetadata } from "@/lib/agent/pi/model-catalog";
import {
  readBenchmarkMaterializationManifest,
} from "./materialization";
import type { BenchmarkMaterializationManifest } from "./contracts";

export type BenchmarkPreflightCheck = {
  id: string;
  ok: boolean;
  blocking: boolean;
  code: string;
  details?: Record<string, unknown>;
};

export type RealApiBudgets = {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxWallMs?: number;
  maxCases?: number;
  maxCostUsd?: number;
};

export type BenchmarkPreflightTarget = "static" | "connection-smoke" | "benchmark-smoke" | "general-agent-pilot" | "pilot" | "full";

export interface BenchmarkPreflightOptions {
  target: BenchmarkPreflightTarget;
  preview: boolean;
  confirmRealApi: boolean;
  environmentGate: boolean;
  budgets: RealApiBudgets;
  materializationManifestPaths?: string[];
  minimumFreeDiskBytes?: number;
  db?: DatabaseSync;
  readSettings?: () => Promise<AgentSettings>;
  checkPython?: () => Promise<PythonDoctorResult>;
  checkSpreadsheet?: () => Promise<SpreadsheetCapabilities>;
  mockAgentEnabled?: () => boolean;
  appDataDir?: string;
}

export type BenchmarkPreflightResult = {
  schemaVersion: 1;
  target: BenchmarkPreflightTarget;
  preview: boolean;
  ok: boolean;
  networkRequests: 0;
  providerHost: string | null;
  models: { fast: string | null; reasoning: string | null };
  pricingKnown: boolean;
  checks: BenchmarkPreflightCheck[];
  materializations: Array<{
    datasetId: string;
    datasetVersion: string;
    split: string;
    cases: number;
    sourceSha256: string;
    licenseStatus: string;
  }>;
};

/** Static/preview gate. This function has no fetch dependency and cannot send a model request. */
export async function runBenchmarkPreflight(
  options: BenchmarkPreflightOptions,
): Promise<BenchmarkPreflightResult> {
  const db = options.db ?? getDb();
  const settings = await (options.readSettings ?? readAgentSettings)();
  const checks: BenchmarkPreflightCheck[] = [];
  const readiness = getModelConfigReadiness(settings);
  const provider = parseProvider(settings.apiUrl);
  checks.push(check("settings.api_key", Boolean(settings.apiKey.trim()), true, "api_key_not_configured"));
  checks.push(check("settings.api_key_persisted", Boolean(settings.apiKey.trim()), true, "api_key_not_persisted"));
  checks.push(check("settings.models", readiness.modelConfigReady, true, "model_config_incomplete", {
    missingModelTiers: readiness.missingModelTiers,
  }));
  checks.push(check("settings.provider_url", provider.ok, true, provider.ok ? "ok" : provider.code));
  checks.push(check(
    "runtime.mock_disabled",
    !(options.mockAgentEnabled ?? isMockAgentEnabled)(),
    true,
    "mock_agent_enabled",
  ));

  try {
    const quick = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    checks.push(check("storage.database", quick?.quick_check === "ok", true, "database_quick_check_failed"));
    const requiredTables = ["artifacts", "artifact_versions", "evidence_records", "assertion_results", "agent_runs"];
    const existing = new Set((db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(() => "?").join(",")})
    `).all(...requiredTables) as Array<{ name: string }>).map((row) => row.name));
    checks.push(check("storage.foundation_tables", requiredTables.every((table) => existing.has(table)), true, "foundation_storage_unavailable"));
  } catch {
    checks.push(check("storage.database", false, true, "database_unavailable"));
  }

  const appDataDir = path.resolve(options.appDataDir ?? getAppDataDir());
  try {
    await fs.mkdir(path.join(appDataDir, "artifacts", "cas"), { recursive: true });
    const stats = await fs.statfs(appDataDir, { bigint: true });
    const freeBytes = Number(stats.bavail * stats.bsize);
    const minimum = options.minimumFreeDiskBytes ?? Math.max(
      512 * 1024 * 1024,
      options.budgets.maxCases ? options.budgets.maxCases * 64 * 1024 * 1024 : 0,
    );
    checks.push(check("storage.disk", freeBytes >= minimum, true, "insufficient_disk_space", {
      freeBytes,
      minimumFreeBytes: minimum,
    }));
  } catch {
    checks.push(check("storage.disk", false, true, "disk_probe_failed"));
  }

  const [python, spreadsheet] = await Promise.all([
    (options.checkPython ?? checkPythonEnvironment)().catch(() => null),
    (options.checkSpreadsheet ?? (() => getSpreadsheetCapabilities()))().catch(() => null),
  ]);
  const toolsBlocking = options.target !== "connection-smoke";
  checks.push(check("runtime.python", python?.ok === true, toolsBlocking, "python_runtime_unavailable", {
    missing: python?.missing ?? [],
  }));
  const spreadsheetReady = Boolean(
    spreadsheet?.python.ok
    && spreadsheet.read.xlsx
    && spreadsheet.write.xlsx
    && !spreadsheet.problems.some((problem) => problem.severity === "blocking"),
  );
  checks.push(check("runtime.spreadsheet", spreadsheetReady, toolsBlocking, "spreadsheet_runtime_unavailable", {
    problems: spreadsheet?.problems.map((problem) => problem.code) ?? ["probe_failed"],
    recalcAvailable: spreadsheet?.recalc.ok ?? false,
  }));

  const materializations: BenchmarkPreflightResult["materializations"] = [];
  const materializationPaths = options.materializationManifestPaths ?? [];
  if (options.target !== "connection-smoke" && options.target !== "static") {
    checks.push(check("data.materialization_present", materializationPaths.length > 0, true, "benchmark_materialization_missing"));
  }
  for (const manifestPath of materializationPaths) {
    try {
      const manifest = await readBenchmarkMaterializationManifest(manifestPath);
      verifyMaterializedArtifacts(db, manifest);
      materializations.push({
        datasetId: manifest.datasetId,
        datasetVersion: manifest.datasetVersion,
        split: manifest.split,
        cases: manifest.cases.length,
        sourceSha256: manifest.sourceSha256,
        licenseStatus: manifest.licenseStatus,
      });
      checks.push(check(`data.manifest:${manifest.datasetId}`, true, true, "ok"));
    } catch {
      checks.push(check(`data.manifest:${path.basename(manifestPath)}`, false, true, "benchmark_materialization_invalid"));
    }
  }

  const paidTarget = options.target !== "static";
  if (paidTarget) {
    checks.push(check("consent.environment", options.environmentGate, true, "real_api_environment_gate_missing"));
    checks.push(check("consent.cli", options.confirmRealApi, true, "real_api_cli_consent_missing"));
    const budgetReady = positive(options.budgets.maxInputTokens)
      && positive(options.budgets.maxOutputTokens)
      && positive(options.budgets.maxWallMs)
      && (options.target === "connection-smoke" || positive(options.budgets.maxCases));
    checks.push(check("consent.budgets", budgetReady, true, "real_api_budget_missing"));
  }
  const modelIds = [settings.fastModel, settings.reasoningModel].filter(Boolean);
  const pricingStates = modelIds.map((modelId) => resolveModelMetadata(modelId, settings.modelPricing).pricingKnown);
  const anyPricingConfigured = pricingStates.some(Boolean);
  const pricingKnown = pricingStates.length > 0 && pricingStates.every(Boolean);
  if (paidTarget && anyPricingConfigured) {
    checks.push(check("consent.cost_budget", nonNegative(options.budgets.maxCostUsd), true, "real_api_cost_budget_missing"));
  }
  const ok = checks.every((item) => item.ok || !item.blocking);
  return {
    schemaVersion: 1,
    target: options.target,
    preview: options.preview,
    ok,
    networkRequests: 0,
    providerHost: provider.ok ? provider.host : null,
    models: {
      fast: settings.fastModel || null,
      reasoning: settings.reasoningModel || null,
    },
    pricingKnown,
    checks,
    materializations,
  };
}

function parseProvider(apiUrl: string): { ok: true; host: string; messagesUrl: string } | { ok: false; code: string } {
  try {
    const url = new URL(apiUrl);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return { ok: false, code: "provider_url_must_use_https" };
    if (/\/messages\/?$/i.test(url.pathname)) return { ok: false, code: "provider_url_must_not_include_messages" };
    const messagesUrl = buildMessagesUrl(apiUrl);
    if (new URL(messagesUrl).hostname.toLowerCase() !== url.hostname.toLowerCase()) {
      return { ok: false, code: "provider_host_changed_during_normalization" };
    }
    return { ok: true, host: url.hostname.toLowerCase(), messagesUrl };
  } catch {
    return { ok: false, code: "provider_url_invalid" };
  }
}

export function resolveMessagesEndpoint(apiUrl: string): { host: string; url: string } {
  const provider = parseProvider(apiUrl);
  if (!provider.ok) throw new Error(provider.code);
  return { host: provider.host, url: provider.messagesUrl };
}

function verifyMaterializedArtifacts(db: DatabaseSync, manifest: BenchmarkMaterializationManifest): void {
  for (const benchmarkCase of manifest.cases) {
    for (const artifact of benchmarkCase.inputArtifacts) {
      const row = db.prepare(`
        SELECT v.sha256, v.media_type, a.logical_name
        FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
        WHERE v.version_id=? AND v.artifact_id=?
      `).get(artifact.versionId, artifact.artifactId) as {
        sha256: string;
        media_type: string;
        logical_name: string;
      } | undefined;
      if (!row || row.sha256 !== artifact.sha256 || row.media_type !== artifact.mediaType || row.logical_name !== artifact.logicalName) {
        throw new Error("materialized artifact mismatch");
      }
    }
  }
}

function check(
  id: string,
  ok: boolean,
  blocking: boolean,
  failureCode: string,
  details?: Record<string, unknown>,
): BenchmarkPreflightCheck {
  return { id, ok, blocking, code: ok ? "ok" : failureCode, ...(details ? { details } : {}) };
}

function positive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegative(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
