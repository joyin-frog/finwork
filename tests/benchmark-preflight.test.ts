import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSettings } from "../lib/settings/agent-settings.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import { runBenchmarkPreflight } from "../lib/evaluation/benchmarks/preflight.ts";
import {
  assertConnectionSmokePreviewReceipt,
  createConnectionSmokePreviewReceipt,
} from "../lib/evaluation/benchmarks/preflight-receipt.ts";
import {
  ConnectionSmokeExecutionError,
  runConnectionSmoke,
} from "../lib/evaluation/benchmarks/connection-smoke.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

const SECRET = "sk-preview-secret-sentinel";
const settings: AgentSettings = {
  apiUrl: "https://provider.example.com",
  apiKey: SECRET,
  companyName: "",
  agentName: "Test Agent",
  userName: "",
  userAvatar: "",
  fastModel: "fake-fast",
  reasoningModel: "fake-reasoning",
  roleMode: "tech",
  telemetryEnabled: false,
  telemetryEndpoint: "",
  telemetryToken: "",
  telemetryInstallId: "benchmark-preflight-test",
};

const pythonReady = async () => ({ ok: true, pythonPath: "/controlled/python", detail: "ok", missing: [] });
const spreadsheetReady = async () => ({
  python: { ok: true },
  packages: {
    openpyxl: { ok: true }, pandas: { ok: true }, xlsxwriter: { ok: true }, xlrd: { ok: true },
  },
  read: { csv: true, xlsx: true, xlsm: true, xls: true },
  write: { xlsx: true, preserveXlsm: false as const },
  recalc: { ok: true, provider: "system_libreoffice" as const },
  render: { ok: true, provider: "system_libreoffice" as const },
  problems: [],
});

export const benchmarkPreflightTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-benchmark-preflight-"));
  const db = makeDb();
  try {
    let networkRequests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkRequests += 1;
      throw new Error("static preflight must not fetch");
    }) as typeof fetch;
    const preview = await runBenchmarkPreflight({
      target: "connection-smoke",
      preview: true,
      confirmRealApi: true,
      environmentGate: true,
      budgets: { maxInputTokens: 2000, maxOutputTokens: 64, maxWallMs: 120_000 },
      db,
      appDataDir: root,
      readSettings: async () => settings,
      checkPython: pythonReady,
      checkSpreadsheet: spreadsheetReady,
      mockAgentEnabled: () => false,
      minimumFreeDiskBytes: 1,
    });
    globalThis.fetch = originalFetch;
    assert.equal(preview.ok, true);
    assert.equal(preview.networkRequests, 0);
    assert.equal(networkRequests, 0);
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(SECRET));
    const previewBudgets = { maxInputTokens: 2000, maxOutputTokens: 64, maxWallMs: 120_000 };
    const previewReceipt = createConnectionSmokePreviewReceipt({
      preflight: preview,
      budgets: previewBudgets,
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    assert.doesNotMatch(JSON.stringify(previewReceipt), new RegExp(SECRET));
    assert.equal(assertConnectionSmokePreviewReceipt({
      receipt: previewReceipt,
      preflight: { ...preview, preview: false },
      budgets: previewBudgets,
    }).networkRequests, 0);
    assert.throws(() => assertConnectionSmokePreviewReceipt({
      receipt: previewReceipt,
      preflight: { ...preview, preview: false },
      budgets: { ...previewBudgets, maxOutputTokens: 65 },
    }), /benchmark_connection_preview_receipt_mismatch/);

    const missingConsent = await runBenchmarkPreflight({
      target: "connection-smoke",
      preview: true,
      confirmRealApi: false,
      environmentGate: false,
      budgets: {},
      db,
      appDataDir: root,
      readSettings: async () => settings,
      checkPython: pythonReady,
      checkSpreadsheet: spreadsheetReady,
      mockAgentEnabled: () => false,
      minimumFreeDiskBytes: 1,
    });
    assert.equal(missingConsent.ok, false);
    assert.deepEqual(
      missingConsent.checks.filter((item) => !item.ok).map((item) => item.code).sort(),
      ["real_api_budget_missing", "real_api_cli_consent_missing", "real_api_environment_gate_missing"].sort(),
    );

    let calls = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status: 503, headers: { "retry-after": "0" } });
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
      const nonce = body.messages[0]!.content.split(": ").at(-1)!;
      assert.match(nonce, /^fw-[fr]-[0-9a-f]{16}$/);
      return new Response(JSON.stringify({
        id: `msg-${calls}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: nonce }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const smoke = await runConnectionSmoke({
      budgets: { maxInputTokens: 100, maxOutputTokens: 20, maxWallMs: 10_000 },
      settings,
      fetchImpl: fakeFetch,
      sleep: async () => undefined,
      pricingKnown: false,
    });
    assert.equal(calls, 3, "one bounded transient retry plus two successful model probes");
    assert.equal(smoke.probes.length, 2);
    assert.equal(smoke.status, "passed");
    assert.equal(smoke.failure, null);
    assert.deepEqual(smoke.probes.map((probe) => probe.responseModelMatchesRequest), [true, true]);
    assert.deepEqual(
      smoke.probes.map((probe) => probe.responseModel),
      ["fake-fast", "fake-reasoning"],
    );
    assert.equal(smoke.totals.retries, 1);
    assert.equal(smoke.costUsd, null);
    assert.doesNotMatch(JSON.stringify(smoke), new RegExp(SECRET));

    let authCalls = 0;
    let authError: unknown;
    try {
      await runConnectionSmoke({
        budgets: { maxInputTokens: 100, maxOutputTokens: 20, maxWallMs: 10_000 },
        settings,
        fetchImpl: async () => {
          authCalls += 1;
          return new Response("unauthorized", { status: 401 });
        },
        sleep: async () => undefined,
        pricingKnown: false,
      });
      assert.fail("401 should reject the connection smoke");
    } catch (error) {
      authError = error;
    }
    assert.equal(authCalls, 1, "401 must stop immediately without retry");
    assert.ok(authError instanceof ConnectionSmokeExecutionError);
    assert.equal(authError.report.status, "failed");
    assert.equal(authError.report.failure?.faultDomain, "dependency");
    assert.equal(authError.report.failure?.code, "provider_auth_failed");
    assert.equal(authError.report.failure?.attempts, 1);
    assert.doesNotMatch(JSON.stringify(authError.report), new RegExp(SECRET));

    let unavailableCalls = 0;
    let unavailableError: unknown;
    try {
      await runConnectionSmoke({
        budgets: { maxInputTokens: 100, maxOutputTokens: 20, maxWallMs: 10_000 },
        settings,
        fetchImpl: async () => {
          unavailableCalls += 1;
          return new Response("unavailable", { status: 503 });
        },
        sleep: async () => undefined,
        pricingKnown: false,
      });
      assert.fail("exhausted 503 retry should reject the connection smoke");
    } catch (error) {
      unavailableError = error;
    }
    assert.equal(unavailableCalls, 2, "503 must have exactly one bounded retry");
    assert.ok(unavailableError instanceof ConnectionSmokeExecutionError);
    assert.equal(unavailableError.report.failure?.code, "provider_unavailable");
    assert.equal(unavailableError.report.failure?.attempts, 2);

    let mismatchCalls = 0;
    let mismatchError: unknown;
    try {
      await runConnectionSmoke({
        budgets: { maxInputTokens: 100, maxOutputTokens: 20, maxWallMs: 10_000 },
        settings,
        fetchImpl: async (_url, init) => {
          mismatchCalls += 1;
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
          const nonce = body.messages[0]!.content.split(": ").at(-1)!;
          return new Response(JSON.stringify({
            model: "unexpected-provider-model",
            content: [{ type: "text", text: nonce }],
            usage: { input_tokens: 5, output_tokens: 2 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
        sleep: async () => undefined,
        pricingKnown: false,
      });
      assert.fail("response model mismatch should reject the connection smoke");
    } catch (error) {
      mismatchError = error;
    }
    assert.equal(mismatchCalls, 1, "response model mismatch must not retry");
    assert.ok(mismatchError instanceof ConnectionSmokeExecutionError);
    assert.equal(mismatchError.report.failure?.code, "provider_response_model_mismatch");
    assert.equal(mismatchError.report.failure?.reportedModel, "unexpected-provider-model");

    console.log("benchmark-preflight: zero-network preview, consent, probe and auth gates passed ✓");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("benchmark-preflight.test")) {
  benchmarkPreflightTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
