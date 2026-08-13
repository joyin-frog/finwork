import type {
  DueDiligenceTopic,
  ResearchCoverageItem,
  ResearchCoverageRequirement,
  ResearchPublicationGate,
  ResearchSnapshot,
} from "./contracts";

const DEFAULT_SOURCE_CLASSES: Record<DueDiligenceTopic, ResearchCoverageRequirement["acceptedSourceClasses"]> = {
  entity: ["regulator", "government", "company_filing"],
  ownership: ["regulator", "company_filing", "professional_database"],
  people: ["regulator", "company_filing", "professional_database"],
  litigation: ["court_registry", "government", "professional_database"],
  penalty: ["regulator", "government"],
  finance: ["company_filing", "regulator", "government"],
  media: ["reputable_media"],
  related_parties: ["company_filing", "regulator", "professional_database"],
};

export function defaultDueDiligenceCoverageRequirements(
  topics: readonly DueDiligenceTopic[],
): ResearchCoverageRequirement[] {
  return topics.map((topic) => ({
    topic,
    acceptedSourceClasses: [...DEFAULT_SOURCE_CLASSES[topic]],
    minIndependentSources: topic === "media" ? 2 : 1,
    minVerifiedClaims: 1,
  }));
}

export function evaluateResearchPublicationGate(input: {
  coverage: ResearchCoverageItem[];
  snapshots: ResearchSnapshot[];
  verifiedClaimCount: number;
  snapshotIntegrityVerified: boolean;
}): ResearchPublicationGate {
  const blockers: string[] = [];
  for (const item of input.coverage) {
    if (item.status === "conflicted") blockers.push(`${item.topic}:unresolved_conflict`);
    if (item.status === "unknown") blockers.push(`${item.topic}:${item.missingRequirements.join("|") || "unknown"}`);
  }
  if (input.snapshots.length === 0) blockers.push("sources:no_admissible_snapshots");
  if (!input.snapshotIntegrityVerified) blockers.push("snapshots:integrity_failed");
  const covered = input.coverage.filter((item) => item.status === "covered").length;
  return {
    status: blockers.length === 0 ? "publishable" : "blocked",
    coverageRatio: input.coverage.length === 0 ? 0 : covered / input.coverage.length,
    verifiedClaimCount: input.verifiedClaimCount,
    sourceCount: input.snapshots.length,
    snapshotIntegrityVerified: input.snapshotIntegrityVerified,
    blockers,
  };
}
