# Agent Capability Foundation — WP0 Baseline and Gate Audit

> Historical WP0 snapshot. The migration ranges and runtime state below describe the implementation entry point on 2026-08-09. They are superseded by [`audit-agent-capability-foundation.md`](./audit-agent-capability-foundation.md) for the final WP0–WP13 implementation and release decision.

Status: **approved to enter WP1–WP3**  
Captured: 2026-08-09  
Authority: `docs/spec/spec-agent-capability-foundation.md` section 18

This document records the mandatory first implementation round. It is an audit artifact, not a substitute for the final WP0–WP13 implementation audit.

## 1. Branch and worktree

- Branch: `codex/ui`
- Baseline commit: `2fa56b9 Refactor application architecture and streamline implementation`
- The worktree was already dirty before runtime implementation because the two approved design documents were untracked.
- First-round changes are restricted to shared contracts, baseline/fixture/migration tooling, tests, and this audit.
- `.codegraph/` and `.finwork-test/` remain local generated state and are not publication inputs.

## 2. Frozen migration ranges and owners

| Migration range | Ownership | Tables / responsibilities |
|---|---|---|
| v24–v27 | Capability / Task / Evidence / Artifact | capability registry, attempts, TaskContractV3, Case/DAG state, Artifact Graph, Evidence Ledger |
| v28–v30 | Memory / Retrieval / IR | governed memory, retrieval corpus/citations, DocumentIR, WorkbookIR |
| v31–v33 | Security / Resource / Evaluation / Lifecycle | policy decisions, taint/secret leases, budgets/usage, evaluation manifests, retention/GC |

| Module | Owner boundary |
|---|---|
| `lib/capability` | Capability Kernel and registry |
| `lib/task` | Task/Case contracts and DAG state |
| `lib/evidence` | Evidence Ledger and claim binding |
| `lib/artifacts` | immutable Artifact Graph and locators |
| `lib/memory-v2` | governed Memory Manager |
| `lib/retrieval` | Retrieval v2 and citation verification |
| `lib/document-ir` | document parse/edit/render IR |
| `lib/workbook-ir` | workbook parse/edit/recalculate/preserve IR |
| `lib/business-rules` | deterministic finance rule engine |
| `lib/research` | source-backed web research protocol |
| `lib/security` | authorization, egress, taint and secret policy |
| `lib/resource` | resource budgets, scheduling and cancellation |
| `lib/evaluation` | manifests, golden, regression and soak evidence |

Migration ownership is exclusive. Downstream modules consume frozen contracts and do not add compatibility columns ad hoc.

## 3. Runtime and database baseline

Source: `.finwork-test/capability-foundation/baseline.json`.

| Item | Value |
|---|---:|
| App data | `/Users/gyro/Library/Application Support/Finwork` |
| Database | `finance-agent.db`, 3,280,896 bytes |
| App-data footprint | 549,114,815 bytes, 16,782 files |
| SQLite schema | `user_version=23`, 31 tables |
| Integrity | `quick_check=ok`, 0 foreign-key violations |
| Baseline collector RSS | 120,537,088 bytes |

Material migration source counts:

| Source | Count |
|---|---:|
| conversations / messages / attachments | 17 / 59 / 41 |
| agent runs / traces / spans / run events | 8 / 29 / 302 / 138 |
| deliverables / artifacts / completion evidence | 12 / 1 / 7 |
| knowledge documents / embeddings | 1 / 0 |
| role memory / profile memory files | 0 / 1 |
| subagent dispatches / tool executions | 12 / 0 |

The initial scanner reported 98 apparent path orphans. Review proved all were scanner mistakes: 29 `agent_traces.router_path=fallback` values and 28 `model_routing_log.path=fallback` values are route states, not paths; 41 attachment paths are relative to `files/<conversation_id>/`. The scanner now uses an explicit file-reference allowlist and conversation-aware attachment resolution. **Actual unexplained orphan count: 0.**

## 4. Fixture matrix

`scripts/capability-foundation-fixtures.mjs` deterministically creates anonymous fixtures under `.finwork-test/capability-foundation/fixtures`; `tests/capability-fixtures.test.ts` validates structure and hashes.

| Required class | Evidence |
|---|---|
| DOCX | generated finance evidence document |
| PDF | generated text PDF |
| scanned/OCR PDF | generated image-only invoice PDF |
| PPTX | generated finance review deck |
| XLS/XLSX/XLSM | existing legacy, normal and macro fixtures |
| external-link workbook | generated workbook with external formula |
| large workbook | generated valid workbook greater than 5 MiB |

Coverage gate: `docx/pdf/pptx/xls/xlsx/scanned/macro/external_link/large = true`.

## 5. Migration rehearsal

Source: `.finwork-test/capability-foundation/migration-dry-run.json`.

- Live DB, WAL and SHM fingerprints were unchanged before and after rehearsal.
- Snapshot initialization from v23 completed and `quick_check` passed.
- Repeated migration execution preserved schema identity.
- Empty-database initialization repeated safely and reached v23.
- Current migrations are therefore idempotent enough to serve as the rollback baseline before v24–v33 are introduced.

Future range rule: every new migration must pass live-copy rehearsal, repeated execution, empty initialization, source fingerprint preservation, and rollback-epoch compatibility before cutover.

## 6. Shared contract diff

The first-round diff freezes strict schemas for:

- capability manifest, preconditions, permissions, side effects, validators, failure and idempotency semantics;
- typed capability execution success/failure (no warning-field success fallback);
- TaskContractV3 and case/DAG references;
- immutable artifact refs and document/workbook locators;
- evidence records and claims;
- governed memory records;
- policy decisions, retention and data handling;
- resource estimates and budgets.

Schemas reject unknown fields. Only `transient_external_failure` is retryable, and automatic retry requires idempotency.

## 7. Current XLSX capability re-evaluation

Legend: ✅ supported; 🟡 partial/fixture-only; ❌ absent.

| Area | Current state |
|---|---|
| multi-sheet/header recognition | ✅ |
| period/account/amount recognition | 🟡 three-statement paths only |
| aggregation / reconciliation | 🟡 reconciliation is bank-oriented |
| formula-error detection and YoY/MoM | ✅ |
| tie-out, duplicate/missing/anomaly and cross-sheet inconsistency | ❌ |
| modify existing workbook / preserve structure and style | ✅ |
| helper columns and formulas | ✅ |
| add/clean/rename/split/merge sheets | ❌ |
| three statements / voucher aggregation / account mapping | ✅ |
| trial balance and expense/revenue analysis | 🟡 |
| multi-company or multi-period consolidation / cross-report checks | ❌ |
| merged cells, filters and freeze panes | ✅ |
| complex formulas / external links / precision | 🟡 |
| dependency graph, hidden dimensions, date semantics and pivot cache | ❌ |
| macros | ❌ preserve-only fixture exists; no safe execution |

The architecture therefore cannot label the current spreadsheet tools as a complete finance workbook capability. WP7 must close these at the IR, recalculation, preservation and evidence layers rather than by adding prompts.

## 8. Silent-degrade and ghost-capability audit

Known blockers before final cutover:

| Path | Current behavior | Required closure |
|---|---|---|
| `lib/knowledge/pipeline.ts` | embedding failure permits successful ingest with zero embeddings | return typed dependency failure or explicit lexical-only mode selected by policy; never silent |
| `lib/agent/router.ts` | router timeout/error becomes complex workflow + RAG | record typed routing failure and select an explicit policy route; do not imply RAG availability |
| `lib/agent/context-policy.ts` | regex selects profiles/tools and unknown work retains full catalog | registry-driven planning with declared capability availability and denied/missing reasons |
| WebSearch/WebFetch UI labels | names can render although production provider wiring is not proven | registry startup validation must reject ghost capabilities |
| document/OCR optional dependencies | some tests skip when runtime is absent | production startup health must expose dependency-unavailable and block unsupported claims |

`tests/capability-no-silent-degrade.test.ts` freezes the replacement boundary: missing dependency/capability is a typed failure, deterministic failures are non-retryable, and a success result cannot carry an undeclared fallback warning. Existing legacy degradation remains a migration debt assigned to WP1, WP5, WP6 and WP9; it is a cutover blocker, not accepted behavior.

## 9. Reviewer audit

### Invariants

- Passed: strict contracts, immutable ArtifactRef identity, locator-bearing evidence, no retry without idempotency, source DB unchanged, fixture coverage complete, and no unexplained file orphan.
- Required before cutover: every runtime tool must resolve through the registry; all delivered claims must bind evidence; no legacy write path; policy and resource decisions must be persisted.

### Failure semantics

- Approved: only transient external failure may auto-retry; capability missing, permission/policy denial, deterministic validation failure and human decision do not retry.
- Repair must be validator-triggered and produce a new artifact version.
- Resource exhaustion pauses or queues; it must not lower validation quality.

### Switch and rollback

- Use additive migrations and shadow writes/reads until parity gates pass.
- Atomic epoch switch only after migration, golden, security, performance and soak gates.
- Rollback changes the active epoch and writer; it does not mutate or erase new evidence/artifacts.
- Legacy writers are deleted only after rollback rehearsal and observation window.

### Review decision

No WP0 blocker remains. WP1–WP3 may begin. Publication remains blocked until the silent-degrade inventory, migration ranges, full test matrix, rollback rehearsal, golden cases and 24-hour soak are closed in the final audit.

## 10. Reproducible WP0 commands

```bash
npm run fixtures:capability-foundation
npm run test:capability-fixtures
npm run test:capability-contracts
npm run test:capability-no-silent-degrade
npm run audit:capability-foundation:baseline
npm run migration:capability-foundation:dry-run
npm run typecheck
```
