import { createHash } from "node:crypto";
import { BenchmarkGapProposalSchema, type BenchmarkCaseResult, type BenchmarkGapProposal } from "./contracts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recommendedFixture(result: BenchmarkCaseResult): string {
  if (result.faultDomain === "validator") return "Add a deterministic artifact assertion that reproduces the failed validator signal.";
  if (result.faultDomain === "evaluator") return "Add an evaluation-harness regression fixture before changing the agent capability.";
  if (result.faultDomain === "policy") return "Add an authorization and confirmation matrix case with explicit principals and data classification.";
  if (result.faultDomain === "resource") return "Add a bounded resource and cancellation fixture with measured budgets.";
  if (result.faultDomain === "dependency") return "Add a dependency failure and retry fixture with structured provider codes.";
  if (result.faultDomain === "model") return "Add a private finance reasoning example after reviewing licensing and memorization risk.";
  return "Add a capability contract fixture that reproduces the missing or invalid execution path.";
}

export function mineBenchmarkGapProposals(results: readonly BenchmarkCaseResult[]): BenchmarkGapProposal[] {
  const groups = new Map<string, BenchmarkCaseResult[]>();
  for (const result of results) {
    if (result.status === "passed") continue;
    const faultDomain = result.faultDomain ?? "capability";
    for (const capability of result.capabilities) {
      const key = `${capability}\u0000${faultDomain}\u0000${result.failures[0] ?? "unknown"}`;
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
  }

  return [...groups.entries()].map(([groupKey, items]) => {
    const first = items[0];
    const capability = first.capabilities.find((candidate) => groupKey.startsWith(`${candidate}\u0000`)) ?? first.capabilities[0];
    const faultDomain = first.faultDomain ?? "capability";
    const dedupeKey = digest(groupKey);
    return BenchmarkGapProposalSchema.parse({
      schemaVersion: 1,
      id: `gap-${dedupeKey.slice(0, 20)}`,
      status: "proposal",
      dedupeKey,
      datasetIds: [...new Set(items.map((item) => item.datasetId))],
      sourceCaseIds: [...new Set(items.map((item) => item.caseId))],
      capability,
      faultDomain,
      title: `${capability}: ${items[0].failures[0] ?? "benchmark failure"}`,
      rationale: `${items.length} benchmark case(s) failed in the ${faultDomain} domain. The proposal requires human review before becoming a private golden case.`,
      recommendedFixture: recommendedFixture(first),
      acceptanceSignals: [
        "The failure reproduces deterministically without a live model.",
        "The owning fault domain is confirmed before capability code changes.",
        "Artifact and citation assertions use immutable evidence rather than self-report.",
      ],
    });
  });
}
