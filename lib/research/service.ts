import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { ArtifactStore } from "@/lib/artifacts/store";
import { EvidenceLedger } from "@/lib/evidence/ledger";
import {
  ResearchFetchedSourceSchema,
  ResearchQueryPlanSchema,
  ResearchReportSchema,
  type ResearchClaimBinding,
  type ResearchConflict,
  type ResearchCoverageItem,
  type ResearchQueryPlan,
  type ResearchReport,
  type ResearchSnapshot,
} from "./contracts";
import { enforceFetchedSourcePolicy, ResearchPolicyError, validateResearchUrl } from "./policy";
import { ResearchProviderError, ResearchProviderRegistry } from "./provider";
import { buildResearchConflicts, buildResearchCoverage, rankResearchCandidates } from "./ranking";
import { defaultDueDiligenceCoverageRequirements, evaluateResearchPublicationGate } from "./due-diligence";
import type { PrincipalRef } from "@/lib/capability/common";
import { authorizeEvidenceWrite } from "@/lib/security/evidence-authorization";
import { SecurityAuthorizer } from "@/lib/security/kernel";

type Clock = () => Date;
export type ResearchExecutionIdentity = {
  principal: PrincipalRef;
  tenantId: string;
  authorizer?: SecurityAuthorizer;
  /** Concrete runtime capability that owns the evidence and policy decision. */
  capabilityId?: string;
};

class ResearchRequestGovernor {
  private readonly requestTimes: number[] = [];
  private total = 0;

  constructor(
    private readonly maxRequestsPerMinute: number,
    private readonly maxTotalRequests: number,
    private readonly now: () => number,
  ) {}

  consume(operation: "search" | "fetch"): void {
    const current = this.now();
    while (this.requestTimes.length > 0 && current - this.requestTimes[0] >= 60_000) this.requestTimes.shift();
    if (this.total >= this.maxTotalRequests) {
      throw new ResearchPolicyError("request_budget_exhausted", `research ${operation} exceeds total request budget`);
    }
    if (this.requestTimes.length >= this.maxRequestsPerMinute) {
      throw new ResearchPolicyError("rate_limit_exceeded", `research ${operation} exceeds requests-per-minute policy`);
    }
    this.total += 1;
    this.requestTimes.push(current);
  }
}

export class ResearchService {
  readonly artifacts: ArtifactStore;
  readonly evidence: EvidenceLedger;

  constructor(
    readonly db: DatabaseSync,
    casRoot: string,
    readonly providers: ResearchProviderRegistry,
    readonly clock: Clock = () => new Date(),
  ) {
    this.artifacts = new ArtifactStore(db, casRoot);
    this.evidence = new EvidenceLedger(db);
  }

  async execute(rawPlan: ResearchQueryPlan, identity: ResearchExecutionIdentity): Promise<ResearchReport> {
    const parsedPlan = ResearchQueryPlanSchema.parse(rawPlan);
    const plan = parsedPlan.coverageRequirements.length > 0
      ? parsedPlan
      : ResearchQueryPlanSchema.parse({
          ...parsedPlan,
          coverageRequirements: defaultDueDiligenceCoverageRequirements(parsedPlan.topics),
        });
    const capabilityId = identity.capabilityId ?? "research.web";
    if (identity.principal.tenantId && identity.principal.tenantId !== identity.tenantId) {
      throw new Error("research execution identity tenant mismatch");
    }
    const authorizer = identity.authorizer ?? new SecurityAuthorizer(this.db);
    this.savePlan(plan, "running");
    try {
      const provider = await this.providers.requireOnline(plan.providerId);
      const requestGovernor = new ResearchRequestGovernor(
        plan.policy.maxRequestsPerMinute,
        plan.policy.maxTotalRequests,
        () => this.clock().getTime(),
      );
      let candidates;
      try {
        requestGovernor.consume("search");
        candidates = await provider.search(plan);
      } catch (error) {
        throw new ResearchProviderError("provider_failed", `research search failed: ${plan.providerId}`, error);
      }

      const rejectedSources: ResearchReport["rejectedSources"] = [];
      const admissible = candidates.filter((candidate) => {
        try {
          validateResearchUrl(candidate.url, plan);
          if (candidate.region && plan.policy.allowedRegions.length > 0 && !plan.policy.allowedRegions.includes(candidate.region)) {
            throw new ResearchPolicyError("region_not_allowed", `research source region is not allowed: ${candidate.region}`);
          }
          return true;
        } catch (error) {
          const policyError = error instanceof ResearchPolicyError ? error : new ResearchPolicyError("policy_failed", String(error));
          rejectedSources.push({ url: candidate.url, code: policyError.code, reason: policyError.message });
          return false;
        }
      });
      const rankedAll = rankResearchCandidates(admissible, plan);
      for (const item of rankedAll.filter((entry) => entry.rating.entityMatch === 0)) {
        rejectedSources.push({
          url: item.candidate.url,
          code: "entity_unresolved",
          reason: `source identity does not match ${plan.subject.legalName}`,
        });
      }
      const ranked = rankedAll.filter((item) => item.rating.entityMatch > 0).slice(0, plan.maxSources);

      const snapshots: ResearchSnapshot[] = [];
      const pendingClaims: Array<{
        binding: ResearchClaimBinding;
        normalizedValue: unknown;
        evidenceId: string;
        artifactVersionId: string;
        quoteHash: string;
        sourceRating: number;
        promptInjection: boolean;
      }> = [];

      for (const { candidate, rating } of ranked) {
        let source;
        try {
          requestGovernor.consume("fetch");
          const fetchedSource = ResearchFetchedSourceSchema.parse(await provider.fetch(candidate, plan));
          source = ResearchFetchedSourceSchema.parse({
            ...fetchedSource,
            publishedAt: fetchedSource.publishedAt ?? candidate.publishedAt,
          });
          const taints = enforceFetchedSourcePolicy(source, plan) as ResearchSnapshot["taints"];
          const snapshotId = randomUUID();
          const content = Buffer.from(source.body, "utf8");
          const artifact = this.artifacts.put({
            kind: "research_snapshot",
            logicalName: `${candidate.title}.snapshot`,
            ownerCaseId: plan.caseId,
            classification: "internal",
            retention: { policyId: "research-evidence", sourceUrl: source.finalUrl },
            mediaType: source.contentType,
            producer: { capabilityId, version: "1.0.0", attemptId: plan.id },
            metadata: {
              requestedUrl: source.requestedUrl,
              finalUrl: source.finalUrl,
              fetchedAt: source.fetchedAt,
              publishedAt: source.publishedAt ?? null,
              effectiveFrom: source.effectiveFrom ?? null,
              effectiveTo: source.effectiveTo ?? null,
              headers: source.headers,
              locale: source.locale,
              license: source.license ?? null,
              robotsAllowed: source.robotsAllowed,
              sourceClass: candidate.sourceClass,
              taints,
            },
            content,
            state: "candidate",
          });
          const snapshot: ResearchSnapshot = {
            id: snapshotId,
            planId: plan.id,
            candidateId: candidate.id,
            artifact,
            requestedUrl: source.requestedUrl,
            finalUrl: source.finalUrl,
            fetchedAt: source.fetchedAt,
            ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
            ...(source.effectiveFrom ? { effectiveFrom: source.effectiveFrom } : {}),
            ...(source.effectiveTo ? { effectiveTo: source.effectiveTo } : {}),
            status: source.status,
            headers: source.headers,
            locale: source.locale,
            contentType: source.contentType,
            ...(source.license ? { license: source.license } : {}),
            robotsAllowed: source.robotsAllowed,
            sourceClass: candidate.sourceClass,
            rating,
            taints,
            contentHash: artifact.sha256,
          };
          this.saveSnapshot(snapshot);
          snapshots.push(snapshot);

          for (const [index, extracted] of source.claims.entries()) {
            const exactQuote = source.body.slice(extracted.start, extracted.end);
            if (exactQuote !== extracted.quote) {
              rejectedSources.push({
                url: source.finalUrl,
                code: "claim_locator_mismatch",
                reason: `claim ${extracted.id} does not match immutable snapshot range`,
              });
              continue;
            }
            const claimId = `claim-${snapshotId}-${index}`;
            const evidenceId = randomUUID();
            const citationId = randomUUID();
            const locator = { kind: "char_range" as const, nodeId: snapshotId, start: extracted.start, end: extracted.end };
            const quoteHash = sha256Json(exactQuote);
            const outputHash = sha256Json({ snapshotHash: artifact.sha256, locator, quoteHash });
            const policyDecisionId = authorizeEvidenceWrite({
              authorizer,
              principal: identity.principal,
              tenantId: identity.tenantId,
              caseId: plan.caseId,
              capabilityId,
              artifactVersionId: artifact.versionId,
              classification: "internal",
              taints: [
                "untrusted_input",
                ...(taints.includes("prompt_injection") ? ["prompt_injection" as const] : []),
                ...(taints.includes("sensitive_personal_data") ? ["personal_data" as const] : []),
              ],
              now: this.clock().toISOString(),
            });
            this.evidence.addEvidence(plan.caseId, {
              id: evidenceId,
              type: "source",
              artifact,
              locator,
              producer: { capabilityId, version: "1.0.0", attemptId: plan.id },
              inputs: [],
              outputHash,
              confidence: extracted.confidence * rating.total,
              uncertainty: taints.includes("prompt_injection") ? ["source contains prompt-injection-like text"] : undefined,
              policyDecisionId,
              createdAt: this.clock().toISOString(),
            });
            pendingClaims.push({
              binding: {
                claimId,
                evidenceId,
                citationId,
                snapshotId,
                topic: extracted.topic,
                statement: extracted.statement,
                locator,
                quoteHash,
                status: "candidate",
              },
              normalizedValue: extracted.normalizedValue,
              evidenceId,
              artifactVersionId: artifact.versionId,
              quoteHash,
              sourceRating: rating.total,
              promptInjection: taints.includes("prompt_injection"),
            });
          }
        } catch (error) {
          const code = error instanceof ResearchPolicyError ? error.code : "provider_failed";
          rejectedSources.push({ url: candidate.url, code, reason: error instanceof Error ? error.message : String(error) });
        }
      }

      const draftBindings = pendingClaims.map((item) => item.binding);
      const normalized = new Map(pendingClaims.map((item) => [item.binding.claimId, item.normalizedValue]));
      const conflicts = buildResearchConflicts(draftBindings, normalized);
      const conflictedIds = new Set(conflicts.flatMap((conflict) => conflict.claimIds));
      const claims = pendingClaims.map((item) => ({
        ...item.binding,
        status: conflictedIds.has(item.binding.claimId)
          ? "contradicted" as const
          : item.sourceRating >= 0.65 && !item.promptInjection
            ? "verified" as const
            : "candidate" as const,
      }));
      for (const [index, item] of pendingClaims.entries()) {
        const claim = claims[index];
        this.evidence.addClaim({
          id: claim.claimId,
          caseId: plan.caseId,
          statement: claim.statement,
          ...(item.normalizedValue === undefined ? {} : { structuredValue: item.normalizedValue as never }),
          evidenceRefs: [item.evidenceId],
          status: claim.status,
        });
        this.evidence.addCitation({
          id: claim.citationId,
          claimId: claim.claimId,
          artifactVersionId: item.artifactVersionId,
          locator: claim.locator,
          quoteHash: item.quoteHash,
          createdAt: this.clock().toISOString(),
        });
        this.saveClaimBinding(claim);
      }
      const coverage = buildResearchCoverage(plan, claims, conflicts, snapshots);
      const unknowns = coverage.filter((item) => item.status !== "covered")
        .map((item) => item.status === "conflicted" ? `${item.topic}: unresolved source conflict` : item.unknownReason!);
      const snapshotIntegrityVerified = snapshots.every((snapshot) => this.verifySnapshotIntegrity(snapshot));
      const publicationGate = evaluateResearchPublicationGate({
        coverage,
        snapshots,
        verifiedClaimCount: claims.filter((claim) => claim.status === "verified").length,
        snapshotIntegrityVerified,
      });
      this.saveResults(plan.id, conflicts, coverage, unknowns, publicationGate, rejectedSources);
      this.updatePlanStatus(plan.id, "succeeded");
      return ResearchReportSchema.parse({ plan, snapshots, claims, conflicts, coverage, unknowns, publicationGate, rejectedSources });
    } catch (error) {
      this.updatePlanStatus(plan.id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  readSnapshot(snapshotId: string): string {
    const row = this.db.prepare("SELECT artifact_version_id FROM research_snapshots WHERE snapshot_id=?")
      .get(snapshotId) as { artifact_version_id: string } | undefined;
    if (!row) throw new Error(`research snapshot not found: ${snapshotId}`);
    return Buffer.from(this.artifacts.read(row.artifact_version_id)).toString("utf8");
  }

  verifyClaimQuote(claimId: string): boolean {
    const row = this.db.prepare(`
      SELECT b.locator_json, b.quote_hash, s.snapshot_id, s.artifact_version_id
      FROM research_claim_bindings b JOIN research_snapshots s ON s.snapshot_id=b.snapshot_id
      WHERE b.claim_id=?
    `).get(claimId) as { locator_json: string; quote_hash: string; snapshot_id: string; artifact_version_id: string } | undefined;
    if (!row) return false;
    const locator = JSON.parse(row.locator_json) as { kind: string; nodeId: string; start: number; end: number };
    if (locator.kind !== "char_range" || locator.nodeId !== row.snapshot_id) return false;
    const body = Buffer.from(this.artifacts.read(row.artifact_version_id)).toString("utf8");
    return sha256Json(body.slice(locator.start, locator.end)) === row.quote_hash;
  }

  verifySnapshotIntegrity(snapshot: ResearchSnapshot): boolean {
    try {
      const content = this.artifacts.read(snapshot.artifact.versionId);
      return createHash("sha256").update(content).digest("hex") === snapshot.contentHash;
    } catch {
      return false;
    }
  }

  private savePlan(plan: ResearchQueryPlan, status: "running"): void {
    this.db.prepare(`
      INSERT INTO research_plans(plan_id, case_id, provider_id, plan_json, status, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(plan.id, plan.caseId, plan.providerId, canonicalJson(plan), status, this.clock().toISOString(), this.clock().toISOString());
  }

  private updatePlanStatus(planId: string, status: "succeeded" | "failed", error?: string): void {
    this.db.prepare("UPDATE research_plans SET status=?, error_message=?, updated_at=? WHERE plan_id=?")
      .run(status, error ?? null, this.clock().toISOString(), planId);
  }

  private saveSnapshot(snapshot: ResearchSnapshot): void {
    this.db.prepare(`
      INSERT INTO research_snapshots(
        snapshot_id, plan_id, candidate_id, artifact_version_id, requested_url, final_url, fetched_at,
        published_at, effective_from, effective_to,
        http_status, headers_json, locale, content_type, license, robots_allowed, source_class,
        rating_json, taints_json, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id, snapshot.planId, snapshot.candidateId, snapshot.artifact.versionId,
      snapshot.requestedUrl, snapshot.finalUrl, snapshot.fetchedAt,
      snapshot.publishedAt ?? null, snapshot.effectiveFrom ?? null, snapshot.effectiveTo ?? null,
      snapshot.status,
      canonicalJson(snapshot.headers), snapshot.locale, snapshot.contentType, snapshot.license ?? null,
      snapshot.robotsAllowed ? 1 : 0, snapshot.sourceClass, canonicalJson(snapshot.rating),
      canonicalJson(snapshot.taints), snapshot.contentHash,
    );
  }

  private saveClaimBinding(claim: ResearchClaimBinding): void {
    this.db.prepare(`
      INSERT INTO research_claim_bindings(
        claim_id, evidence_id, citation_id, snapshot_id, topic, locator_json, quote_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.claimId, claim.evidenceId, claim.citationId, claim.snapshotId, claim.topic,
      canonicalJson(claim.locator), claim.quoteHash, claim.status,
    );
  }

  private saveResults(
    planId: string,
    conflicts: ResearchConflict[],
    coverage: ResearchCoverageItem[],
    unknowns: string[],
    publicationGate: ResearchReport["publicationGate"],
    rejectedSources: ResearchReport["rejectedSources"],
  ): void {
    this.db.prepare(`
      INSERT INTO research_reports(
        plan_id, conflicts_json, coverage_json, unknowns_json, publication_gate_json, rejected_sources_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId, canonicalJson(conflicts), canonicalJson(coverage), canonicalJson(unknowns),
      canonicalJson(publicationGate), canonicalJson(rejectedSources), this.clock().toISOString(),
    );
  }
}
