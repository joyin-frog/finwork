# Agent Capability Foundation — WP0–WP13 Final Implementation Audit

> Captured: 2026-08-12  
> Scope: `docs/spec/spec-agent-capability-foundation.md` WP0–WP13  
> Implementation status: **code complete; local deterministic gates passed**  
> Production release status: **not approved for cutover**  
> Current authority: **`shadow + legacy`**

## 1. Executive decision

The unified capability foundation is implemented as one connected architecture rather than a collection of feature fallbacks. Capability contracts, Task/Case state, Artifact/Evidence, governed memory, Retrieval v2, Document/Workbook IR, business rules, research, security, lifecycle, resource governance, evaluation and rollout now share versioned contracts and database ownership.

This audit does **not** declare production Definition of Done. The rollout controller deliberately initializes to `shadow + legacy`; only an explicit atomic `cutover` epoch can make the new path authoritative. The remaining release gates are:

1. real Provider/Office/network end-to-end runs for the four required business scenarios;
2. a real 24-hour soak rather than only the accelerated 24-hour model;
3. real-model Golden quality run with stable Provider credentials;
4. packaged pre-production shadow comparison, cutover and rollback rehearsal;
5. closure of the integration gates before retiring the legacy write path.

No production database was switched by this implementation audit.

## 2. Implemented work packages

| WP | Implementation | Primary ownership | Local evidence |
|---|---|---|---|
| WP0 | Baseline, anonymous fixtures, migration rehearsal | `scripts/capability-foundation-*`, fixture tests | Baseline and repeatable dry-run gates |
| WP1 | Capability manifest, Registry, preflight, executor and structured failures | `lib/capability/` | contract/kernel/no-silent-degrade tests |
| WP2 | TaskContractV3, Case/DAG, checkpoints and production runtime | `lib/task/` | task/artifact/evidence and production-runtime tests |
| WP3 | CAS Artifact Graph, locators, Evidence Ledger and delivery binding | `lib/artifacts/`, `lib/evidence/` | graph, evidence and atomic-write tests |
| WP4 | Governed Memory v2 candidate, approval, conflict, expiry and prompt selection | `lib/memory-v2/` | store, candidate-tool and prompt-migration tests |
| WP5 | ACL-aware Retrieval v2, structural chunks, hybrid/ANN search, citation validation and production bridge | `lib/retrieval/`, knowledge routes/pipeline | retrieval, pool, bridge and 100k-chunk tests |
| WP6 | Document IR adapters, locators, unsupported-feature representation and round-trip checks | `lib/document-ir/` | Document IR tests |
| WP7 | Workbook IR, bounded creation, Patch Plan, preservation, formula security, recalc gate and finance rules | `lib/workbook-ir/`, `lib/business-rules/` | workbook/create/rules tests |
| WP8 | Business cases, role views, schedule and restartable state | `lib/case-management/` | business-case tests |
| WP9 | Source-backed research, provider policy, ranking, conflicts and evidence | `lib/research/` | research foundation tests |
| WP10 | ACL/taint/DLP/quarantine/network/secret/audit kernel | `lib/security/` | security matrix |
| WP11 | Artifact retention, reference-safe GC and dry-run explanations | `lib/file-lifecycle/` | lifecycle and GC-safety tests |
| WP12 | Resource ledger, reservations, worker/backpressure contracts, output spool, caches and maintenance | `lib/resource/` | governor and accelerated soak tests |
| WP13 | Evaluation manifests, fault classification, scorecards, diagnostics, APIs and atomic rollout epochs | `lib/evaluation/`, `lib/observability/`, `lib/runtime/capability-foundation-*` | evaluation, diagnostics, gateway and rollout tests |

## 3. Production execution path

The production finance catalog is registered through `FinanceCapabilityRuntime`:

1. `instrumentation.ts` synchronizes the complete production tool catalog at every Node runtime startup; a synchronization failure blocks startup instead of leaving stale registry state;
2. removed finance-owned definitions are retained as deprecated audit records and their instances are marked unavailable rather than silently disappearing;
3. the existing finance authorizer remains the permission and confirmation boundary;
4. every production tool must have an explicit capability policy for operation, side effects, permissions, evidence and idempotency;
5. the Registry receives a versioned schema-backed capability definition;
6. the resource governor reserves execution budget before the capability handler runs;
7. the rollout gateway chooses exactly one authoritative executor;
8. TaskContractV3, Artifact and Evidence bind execution and delivery state.

The gateway has no failure fallback:

- `shadow + legacy`: invokes legacy exactly once; it does not implicitly invoke the new handler. A comparison is only possible when the caller supplies an explicitly side-effect-free shadow executor.
- `cutover + new`: invokes the new capability path exactly once; failure is returned as failure and never retries through legacy.
- `rollback + legacy`: invokes legacy exactly once.

This preserves the existing authorization, cancellation, confirmation and run-settled contracts while moving execution governance under the new kernel after cutover.

## 4. Key capability details

### 4.1 Memory and retrieval

- Memory is evidence-bound and has candidate, approved, conflicting, superseded, expired and archived lifecycle states.
- Prompt assembly selects governed memory instead of copying an unbounded conversation history.
- Retrieval v2 enforces ACL and business dimensions before ranking, combines lexical and vector candidates, validates locators and citations, and uses bounded embedding workers.
- Production knowledge search, reindexing, document mutation and agent query paths are wired to Retrieval v2 through migration v36. Migrations v37–v42 add resumable resource soak, governed memory archival and conflict repair, persisted security decisions, research publication gates and file-safety manifests.
- The 100k-chunk test verifies ANN candidate retrieval rather than a full vector table scan.

### 4.2 Document and workbook processing

- Document IR represents normalized nodes and precise locators; unsupported structures are explicit rather than silently discarded.
- Workbook IR separates parsing, patch planning, formula dependency/recalculation, preservation checks and business assertions.
- `patch_workbook`, `check_workbook_ties`, `detect_data_issues` and `merge_labeled_tables` have explicit production policies.
- `create_workbook` creates bounded XLSX files without arbitrary code or arbitrary output paths. It rejects external/DDE/network formulas and value/formula ambiguity, writes atomically without overwrite, and returns a content hash.
- The project XLSX skill now routes new workbooks through `create_workbook` and existing workbooks through `patch_workbook`; Python/Bash are not implementation fallbacks.

### 4.3 Research, security and lifecycle

- Research saves source snapshot metadata, coverage and conflicting evidence through provider policies.
- Web/file input remains tainted; security decisions gate capability execution, egress, file admission and secret leases.
- Quarantine covers magic bytes, archive limits, macro/external-link/formula risks and path traversal.
- Artifact lifecycle computes reference-safe candidates, supports explainable dry-run, and keeps destructive cleanup separate from eligibility calculation.

## 5. Database migrations

All migrations are additive and version-owned in `lib/db/migrations.ts`.

| Version | Name | Owner |
|---:|---|---|
| 24 | `capability_kernel` | Registry, attempts and capability metadata |
| 25 | `task_case_orchestration` | TaskContractV3, Case/DAG and checkpoints |
| 26 | `artifact_graph_and_cas` | Artifact graph and content-addressed storage metadata |
| 27 | `evidence_ledger` | Claims, assertions, locators and delivery evidence |
| 28 | `governed_memory_v2` | Governed memory lifecycle |
| 29 | `retrieval_v2` | Corpus, chunks, embeddings, access and citations |
| 30 | `business_case_graph` | Business case state and role views |
| 31 | `research_evidence_foundation` | Research sources and evidence |
| 32 | `security_kernel` | Policy, taint, quarantine, DLP and secret metadata |
| 33 | `artifact_lifecycle_gc` | Retention, references and GC state |
| 34 | `resource_governance` | Budgets, reservations and usage |
| 35 | `evaluation_observability_and_rollout` | Manifests, scorecards, diagnostics and rollout epochs |
| 36 | `knowledge_retrieval_v2_binding` | Production knowledge/retrieval binding |
| 37 | `resource_soak_and_temp_workspace_lifecycle` | Durable soak checkpoints, resumable runs and two-phase temporary-workspace cleanup |
| 38 | `governed_memory_archive_lifecycle` | Governed memory archive records, retention and lifecycle evidence |
| 39 | `rebuild_manual_memory_conflict_keys` | Deterministic conflict keys for governed manual-memory candidates |
| 40 | `persist_security_policy_decisions` | Durable authorization, DLP and security-policy decision evidence |
| 41 | `research_publication_gate` | Research coverage, freshness and publication-decision persistence |
| 42 | `quarantine_file_safety_manifest` | Archive/Office/CSV safety findings and quarantine manifests |

The dry-run opens the source read-only, creates a SQLite backup snapshot, applies migrations to the snapshot, runs integrity and repeatability checks, and rehearses an empty database. The current rehearsal inspected the actual user database at `user_version=40` read-only and migrated only its project-owned snapshot to v42. Database, WAL and SHM fingerprints were unchanged before and after the rehearsal; the repeated snapshot and empty-database paths were stable.

## 6. Files changed

This worktree already contained user-owned UI changes. This audit only claims the architecture-owned changes below; unrelated UI diffs were preserved and not rewritten.

### Added modules

- `lib/capability/`, `lib/task/`, `lib/artifacts/`, `lib/evidence/`
- `lib/memory-v2/`, `lib/retrieval/`
- `lib/document-ir/`, `lib/workbook-ir/`, `lib/business-rules/`
- `lib/case-management/`, `lib/research/`, `lib/security/`
- `lib/file-lifecycle/`, `lib/resource/`, `lib/evaluation/`
- `lib/observability/foundation-*`
- `lib/runtime/capability-foundation-gateway.ts`
- `lib/runtime/capability-foundation-rollout.ts`
- `lib/agent/tools/capability-policy.ts`
- `lib/agent/tools/capability-runtime.ts`
- `lib/agent/mcp-tools/create-workbook.ts`
- capability/diagnostic API and pages under `app/api/capability-foundation/`, `app/api/dev/`, `app/capability-foundation/` and `app/dev/capability-foundation/`

### Modified production seams

- finance tool registry, Pi tool adapter/service and subagent contracts/prompts;
- knowledge query/search/reindex/document routes and ingestion pipeline;
- artifact store/provider and deliverable finalization/validators;
- agent contracts, provenance, system prompt and tool renderers;
- database migrations, worker protocol, package scripts and AS0 fixtures;
- project XLSX skill and regression suites.

### Added implementation tests

Capability, Task/Artifact/Evidence, Memory, Retrieval, Document/Workbook IR, finance rules, business cases, research, security, lifecycle, resource governance, evaluation, rollout/gateway, production runtime, diagnostics and workbook creation each have dedicated test files under `tests/`.

## 7. Validation evidence

| Gate | Result | Evidence / interpretation |
|---|---|---|
| `npm run typecheck` | PASS | TypeScript production contracts compile |
| `npm run test:workbook-ir` | PASS | Parse/patch/create/formula/preservation coverage |
| `node --import tsx tests/as0/validate.ts` | PASS | 20 tasks, 8 fixtures, 14 skills, 53 production tools; direct runner avoids sandbox-denied `tsx` IPC |
| `npm run lint` | PASS with warnings | 0 errors; 171 warnings remain across existing UI/dependency seams |
| `npm run test:capability-foundation` | PASS | evaluation, rollout, gateway, finance runtime, Task v3 and diagnostics |
| `npm run eval:security` | PASS | deterministic security matrix |
| `npm run eval:as0:typecheck` | PASS | AS0 evaluation harness compiles |
| `npm run migration:capability-foundation:dry-run` | PASS | actual user source stayed at v40; read-only source/database/WAL/SHM fingerprints, v42 snapshot rehearsal, repeatability and empty-DB gates passed |
| `node --import tsx tests/all.test.ts` | PASS | 11 top-level suites, 0 failures; direct runner avoids sandbox-denied `tsx` IPC |
| `NODE_OPTIONS=--max-old-space-size=4096 npm run build` | PASS | production build completed under a 4 GiB Node heap cap; 51 static pages generated |
| production startup catalog/API/browser check | PASS | startup synchronized 53 available capabilities; `/api/capability-foundation` returned the same count; `/capability-foundation` rendered governance sections with no browser warnings or errors |
| Golden static run (`SKIP_LLM=true`) | PASS protocol threshold | 46/51 cases; average 0.626, threshold 0.5; no real-model quality claim |
| `npm run eval:resource-soak:accelerated` | PASS mechanism-only | 9,612 iterations, 4 resumes, 21 checkpoints, no failures; report explicitly rejects use as release evidence |
| `npm run test:preproduction-e2e` | PASS | four required scenario protocols and seven fault domains covered deterministically |
| `npm run eval:preproduction-e2e` | EXPECTED BLOCKED | no external fixtures/provider/Office credentials; structured blocked report emitted instead of fallback success |

### 7.1 Immutable local evidence references

- Pre-production blocked run: run id `f629bf49-0332-4a63-a8e4-c688fab8edf0`; embedded report SHA-256 `a2ce63951492e850e7cf3cb458c111e6f122df246f18c9abf94dede22a1c33ab` (file SHA-256 `0ac549b5085315452579201fee16a1cfd83a88c0c6a2ca89c66aa2d97ed00904`). It records missing controlled fixtures and unauthorized web egress as blockers, with zero fabricated failures or passes.
- Accelerated resource-soak run: run id `1732d8b7-1791-44ae-afde-b97da9cdb970`; report `.finwork-test/resource-soak/resource-soak-report.json`; report SHA-256 `f9ea0613cb14ca87678d9c9b9fcfaaf2c46b040481c9144177765787af05670c`; final evidence hash `0e872a2c4c49f2ad17043c997105557a691f2688cda3ea770d7a6cf73fe5a4ab`.
- Migration rehearsal source: `/Users/gyro/Library/Application Support/Finwork/finance-agent.db` was opened read-only at `user_version=40`; only the project-owned snapshot reached v42 and all observed source fingerprints stayed unchanged.

## 8. Deviations and open risks

### 8.1 Golden quality boundary

- The latest local run intentionally used `SKIP_LLM=true`: 46/51 cases passed with average `0.626` against threshold `0.5`.
- This proves fixture, scorer and protocol wiring only. It cannot replace a real-model run, and the five failed static/mock cases are retained rather than weakened to inflate the score.
- Production release requires a stable configured Provider, per-case contract compliance and immutable artifact/evidence inspection; aggregate score alone cannot waive an individual required business case.

### 8.2 Environment-bound verification

- The resource soak report is marked `mechanism-only-not-release-evidence`; it is an accelerated deterministic model, not a wall-clock 24-hour packaged-app run.
- Real Office/LibreOffice recalculation, licensed research providers and external network policies require a configured pre-production environment.
- The current machine does not provide `rapidocr`; deterministic OCR routing tests pass, but real scanned-document OCR execution is skipped and remains a release blocker.
- AS0 validation imports the production tool catalog and attempts an automatic backup under the user data root. The backup was denied in this sandbox and did not mutate the source, but the harness should be isolated behind an explicit temporary app-data root before CI is treated as hermetic.
- The required complex consolidation, tax/payroll, multi-document RAG and network due-diligence scenarios need real end-to-end artifact inspection and immutable CompletionEvidence.

### 8.3 Existing quality debt

- ESLint currently reports 171 warnings but no errors. They were not hidden by changing the lint gate; broad unrelated UI cleanup is outside this implementation audit.
- The worktree contains unrelated user UI changes; this audit does not claim or revert them.

## 9. Rollout and rollback

The rollout table has one active epoch enforced by a partial unique database index. Epoch transitions retire the previous authority and create the new authority inside `BEGIN IMMEDIATE`.

- Initial state: `shadow + legacy`.
- Cutover: explicit `cutover(reason)` creates `cutover + new`.
- Rollback: explicit `rollback(reason)` creates `rollback + legacy`.
- Shadow execution is not duplicated unless an operation supplies a dedicated side-effect-free comparison implementation.
- No new-path failure invokes legacy as fallback.

Legacy registration and write paths must remain until the pre-production gates pass. They must be deleted in the same release that completes the successful cutover, not earlier and not as a long-lived dual track.

## 10. Definition of Done matrix

| Spec DoD | Local implementation | Production closure |
|---|---|---|
| 1. WP0–WP13 | Complete | release gates pending |
| 2. Registry is capability SSOT | Implemented for production finance catalog | activate new authority, then remove duplicate legacy registration |
| 3. New Task/Case/Artifact/Evidence/Memory/Citation contracts | Implemented and tested | migrate/inspect production data during pre-production rehearsal |
| 4. Document/Workbook IR formal I/O | Implemented and tested | real Office and golden artifact round trips pending |
| 5. Four required end-to-end cases | Protocols and local tests implemented | real complex cases pending |
| 6. Evidence for formal claims/files | Ledger and delivery gates implemented | real E2E evidence inspection pending |
| 7. Security matrix and 24h soak | security PASS; accelerated soak PASS | real 24h packaged soak pending |
| 8. Existing contracts no regression | full local test/build/AS0 PASS | packaged pre-production regression pending |
| 9. Atomic switch and legacy deletion | mechanism tested | actual cutover/rollback rehearsal and deletion pending |
| 10. Final audit | Complete | update with release evidence at cutover |

## 11. Release sequence

1. Run the packaged application against a copied pre-production data root and capture the current-production-version→v42 rehearsal artifact.
2. Execute the four required real end-to-end scenarios, inspect generated DOCX/PDF/PPTX/XLSX files, and bind validator output to artifact hashes.
3. Run the Golden suite against the production candidate model and close every required per-case contract failure; do not waive a failed case with the aggregate score.
4. Run the real 24-hour resource soak with repeated large files, cancellation, restart and concurrency; verify RSS, child processes, temporary files, cache and index budgets converge.
5. Enter explicit shadow comparison only for side-effect-free implementations and review mismatch/inconclusive records.
6. Rehearse atomic cutover and rollback in pre-production.
7. Cut over once, remove legacy write/duplicate registrations in the same release, rerun all gates, and append production evidence to this audit.

Until these steps pass, the correct state is **implemented but not production-authoritative**.
