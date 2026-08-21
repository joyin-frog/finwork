import type { FaultDomain } from "./contracts";

const KIND_TO_DOMAIN: Readonly<Record<string, FaultDomain>> = {
  invalid_input: "capability",
  capability_missing: "capability",
  dependency_unavailable: "dependency",
  permission_denied: "policy",
  policy_blocked: "policy",
  resource_exhausted: "resource",
  transient_external_failure: "dependency",
  deterministic_validation_failed: "validator",
  human_decision_required: "policy",
  canceled: "resource",
  model_invalid_output: "model",
  model_refusal: "model",
  evaluator_error: "evaluator",
  internal_error: "capability",
};

/** Structured codes own attribution. Human-readable messages are deliberately ignored. */
export function classifyFault(input: { kind?: string; code?: string; source?: string }): FaultDomain {
  if (input.source === "evaluator") return "evaluator";
  if (input.source === "model") return "model";
  if (input.source === "validator") return "validator";
  if (input.source === "policy") return "policy";
  if (input.source === "resource") return "resource";
  return KIND_TO_DOMAIN[input.kind ?? ""] ?? "capability";
}
