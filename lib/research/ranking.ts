import { canonicalJson } from "@/lib/capability/hash";
import type {
  DueDiligenceTopic,
  ResearchCandidate,
  ResearchClaimBinding,
  ResearchConflict,
  ResearchCoverageItem,
  ResearchQueryPlan,
  ResearchSnapshot,
  ResearchSourceClass,
  ResearchSourceRating,
} from "./contracts";

const AUTHORITY: Record<ResearchSourceClass, number> = {
  regulator: 1,
  court_registry: 0.98,
  company_filing: 0.93,
  government: 0.92,
  professional_database: 0.8,
  reputable_media: 0.7,
  other_media: 0.5,
  blog: 0.25,
  social: 0.1,
};

const PRIMARY = new Set<ResearchSourceClass>(["regulator", "court_registry", "company_filing", "government"]);

function normalizedName(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function scoreEntityMatch(candidate: ResearchCandidate, plan: ResearchQueryPlan): number {
  const names = [plan.subject.legalName, ...plan.subject.aliases].map(normalizedName);
  const candidateNames = candidate.entityNames.map(normalizedName);
  const nameMatch = candidateNames.some((candidateName) => names.includes(candidateName)) ? 0.7 : 0;
  const subjectIds = Object.entries(plan.subject.identifiers);
  const identifierMatch = subjectIds.length > 0 && subjectIds.some(([key, value]) => candidate.entityIdentifiers[key] === value) ? 0.3 : 0;
  return Math.min(1, nameMatch + identifierMatch);
}

export function rateResearchCandidate(candidate: ResearchCandidate, plan: ResearchQueryPlan): ResearchSourceRating {
  const authority = AUTHORITY[candidate.sourceClass];
  const primarySource = PRIMARY.has(candidate.sourceClass) ? 1 : 0;
  const entityMatch = scoreEntityMatch(candidate, plan);
  const published = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.NaN;
  const ageYears = Number.isFinite(published) ? Math.max(0, (Date.parse(plan.asOf) - published) / 31_556_952_000) : 10;
  const recency = Math.max(0, 1 - ageYears / 10);
  const total = Math.min(1, authority * 0.4 + primarySource * 0.2 + entityMatch * 0.3 + recency * 0.1);
  return {
    authority,
    primarySource,
    entityMatch,
    recency,
    total,
    reasons: [
      `source:${candidate.sourceClass}`,
      `entity_match:${entityMatch.toFixed(2)}`,
      primarySource === 1 ? "primary_source" : "secondary_source",
    ],
  };
}

export function rankResearchCandidates(candidates: ResearchCandidate[], plan: ResearchQueryPlan) {
  return candidates
    .map((candidate) => ({ candidate, rating: rateResearchCandidate(candidate, plan) }))
    .sort((a, b) => b.rating.total - a.rating.total || a.candidate.url.localeCompare(b.candidate.url));
}

export function buildResearchConflicts(
  claims: ResearchClaimBinding[],
  normalizedValueByClaim: Map<string, unknown>,
): ResearchConflict[] {
  const byTopic = new Map<DueDiligenceTopic, ResearchClaimBinding[]>();
  for (const claim of claims) byTopic.set(claim.topic, [...(byTopic.get(claim.topic) ?? []), claim]);
  const conflicts: ResearchConflict[] = [];
  for (const [topic, topicClaims] of byTopic) {
    const values = new Map<string, { value: unknown; ids: string[] }>();
    for (const claim of topicClaims) {
      const value = normalizedValueByClaim.get(claim.claimId);
      if (value === undefined) continue;
      const key = canonicalJson(value);
      const entry = values.get(key) ?? { value, ids: [] };
      entry.ids.push(claim.claimId);
      values.set(key, entry);
    }
    if (values.size > 1) {
      conflicts.push({
        id: `conflict-${topic}`,
        topic,
        claimIds: [...values.values()].flatMap((entry) => entry.ids),
        normalizedValues: [...values.values()].map((entry) => entry.value as never),
        status: "unresolved",
      });
    }
  }
  return conflicts;
}

export function buildResearchCoverage(
  plan: ResearchQueryPlan,
  claims: ResearchClaimBinding[],
  conflicts: ResearchConflict[],
  snapshots: ResearchSnapshot[],
): ResearchCoverageItem[] {
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const requirements = new Map(plan.coverageRequirements.map((requirement) => [requirement.topic, requirement]));
  return plan.topics.map((topic) => {
    const topicClaims = claims.filter((claim) => claim.topic === topic);
    const verifiedClaims = topicClaims.filter((claim) => claim.status === "verified");
    const conflicted = conflicts.some((conflict) => conflict.topic === topic);
    const requirement = requirements.get(topic);
    const acceptedClasses = requirement?.acceptedSourceClasses ?? [];
    const acceptedClaims = requirement
      ? verifiedClaims.filter((claim) => {
          const sourceClass = snapshotById.get(claim.snapshotId)?.sourceClass;
          return sourceClass !== undefined && acceptedClasses.includes(sourceClass);
        })
      : verifiedClaims;
    const sourceCount = new Set(acceptedClaims.map((claim) => claim.snapshotId)).size;
    const minSources = requirement?.minIndependentSources ?? 1;
    const minClaims = requirement?.minVerifiedClaims ?? 1;
    const missingRequirements: string[] = [];
    if (acceptedClaims.length < minClaims) missingRequirements.push(`verified_claims:${acceptedClaims.length}/${minClaims}`);
    if (sourceCount < minSources) missingRequirements.push(`independent_sources:${sourceCount}/${minSources}`);
    if (requirement && acceptedClaims.length === 0) {
      missingRequirements.push(`accepted_source_class:${acceptedClasses.join("|")}`);
    }
    const covered = !conflicted && missingRequirements.length === 0;
    return {
      topic,
      status: conflicted ? "conflicted" as const : covered ? "covered" as const : "unknown" as const,
      claimIds: topicClaims.map((claim) => claim.claimId),
      sourceCount,
      verifiedClaimCount: acceptedClaims.length,
      acceptedSourceClasses: acceptedClasses,
      missingRequirements,
      ...(!covered && !conflicted ? { unknownReason: `coverage requirements not met for ${topic}: ${missingRequirements.join(", ")}` } : {}),
    };
  });
}
