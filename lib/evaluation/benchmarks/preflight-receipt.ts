import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@/lib/capability/hash";
import type { BenchmarkPreflightResult, RealApiBudgets } from "./preflight";

const ConnectionSmokePreviewPayloadSchema = z.object({
  providerHost: z.string().trim().min(1),
  models: z.object({
    fast: z.string().trim().min(1),
    reasoning: z.string().trim().min(1),
  }).strict(),
  budgets: z.object({
    maxInputTokens: z.number().positive(),
    maxOutputTokens: z.number().positive(),
    maxWallMs: z.number().positive(),
    maxCostUsd: z.number().nonnegative().optional(),
  }).strict(),
}).strict();

export const ConnectionSmokePreviewReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.literal("connection-smoke"),
  createdAt: z.iso.datetime({ offset: true }),
  ok: z.literal(true),
  networkRequests: z.literal(0),
  payload: ConnectionSmokePreviewPayloadSchema,
  fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ConnectionSmokePreviewReceipt = z.infer<typeof ConnectionSmokePreviewReceiptSchema>;

export function createConnectionSmokePreviewReceipt(input: {
  preflight: BenchmarkPreflightResult;
  budgets: RealApiBudgets;
  createdAt: string;
}): ConnectionSmokePreviewReceipt {
  if (input.preflight.target !== "connection-smoke"
    || !input.preflight.preview
    || !input.preflight.ok
    || input.preflight.networkRequests !== 0) {
    throw new Error("benchmark_connection_preview_not_passed");
  }
  const payload = createPayload(input.preflight, input.budgets);
  return ConnectionSmokePreviewReceiptSchema.parse({
    schemaVersion: 1,
    target: "connection-smoke",
    createdAt: input.createdAt,
    ok: true,
    networkRequests: 0,
    payload,
    fingerprintSha256: sha256(canonicalJson(payload)),
  });
}

export function assertConnectionSmokePreviewReceipt(input: {
  receipt: unknown;
  preflight: BenchmarkPreflightResult;
  budgets: RealApiBudgets;
}): ConnectionSmokePreviewReceipt {
  const receipt = ConnectionSmokePreviewReceiptSchema.parse(input.receipt);
  if (receipt.fingerprintSha256 !== sha256(canonicalJson(receipt.payload))) {
    throw new Error("benchmark_connection_preview_receipt_tampered");
  }
  const currentPayload = createPayload(input.preflight, input.budgets);
  if (canonicalJson(receipt.payload) !== canonicalJson(currentPayload)) {
    throw new Error("benchmark_connection_preview_receipt_mismatch");
  }
  return receipt;
}

function createPayload(preflight: BenchmarkPreflightResult, budgets: RealApiBudgets) {
  return ConnectionSmokePreviewPayloadSchema.parse({
    providerHost: preflight.providerHost,
    models: {
      fast: preflight.models.fast,
      reasoning: preflight.models.reasoning,
    },
    budgets: {
      maxInputTokens: budgets.maxInputTokens,
      maxOutputTokens: budgets.maxOutputTokens,
      maxWallMs: budgets.maxWallMs,
      ...(budgets.maxCostUsd === undefined ? {} : { maxCostUsd: budgets.maxCostUsd }),
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
