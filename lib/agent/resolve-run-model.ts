/** Resolve the main Agent model after Router without letting Router change user cost choice. */

import {
  modelConfigFromSettings,
  resolveExecutionModel,
  type ModelFields,
  type ResolvedModel,
} from "@/lib/settings/model-config";
import { normalizeTier } from "@/lib/agent/router";

export type RouterPathForModel = "cheap" | "main" | "fallback";

export type ResolveRunModelInput = {
  settings: ModelFields;
  /** Chat composer selection. Missing means fast. */
  modelTier?: string;
  routerPath: RouterPathForModel;
  routerFailureHint?: string | null;
};

/**
 * Main Agent selection is intentionally simple:
 * - default -> fast model
 * - user selects deep reasoning -> reasoning model
 * Router intent and specialist role never silently upgrade cost.
 */
export function resolveRunExecutionModel(input: ResolveRunModelInput): ResolvedModel | null {
  const config = modelConfigFromSettings(input.settings);
  if (!config) return null;
  return resolveExecutionModel({
    config,
    purpose: "task",
    tier: normalizeTier(input.modelTier),
    ...(input.routerPath === "fallback"
      ? { fallbackReason: inferRouterFallbackReason(input.routerFailureHint) }
      : {}),
  });
}

export function inferRouterFallbackReason(
  hint?: string | null,
): "router_timeout" | "router_invalid" | "router_disabled" {
  const h = (hint ?? "").toLowerCase();
  if (h.includes("timeout") || h.includes("abort") || h.includes("timed out")) return "router_timeout";
  if (h.includes("disabled") || h.includes("router disabled")) return "router_disabled";
  return "router_invalid";
}
