# Phase 7 gap disposition

This review converts benchmark failures into regression inputs; it does not automatically label every failed case as a model defect. The generated JSON remains proposal-only under `.finwork-test/benchmarks/reports/`.

## Reviewed evidence

| Evidence | Generated proposals | Human disposition |
| --- | ---: | --- |
| Finance 7-case run `real-benchmark-0ef1a3d8-52bc-43cd-b899-8989019bb5f4` | 10 | Answer mismatches are retained as finance-reasoning candidates. Citation failures are owned by the Agent retrieval/citation path, not a direct-model score. `foundation_required_evidence_missing` is a Harness/validator failure. |
| General Agent 20-case run `real-benchmark-2631444f-da94-4d18-a1d0-ad127dcf5664` | 6 | Both underlying policy failures (`human_decision_requested` and `scope_change_detected`) were reproduced, repaired in the AskUserQuestion/policy path, and closed by the later 20/20 Layer 2 run. They remain regression coverage, not open model gaps. |
| Final Layer 2 and Phase 6 semantic rescores | 0 open proposals | Passing reports are closure evidence. Pre-rescore Layer 3 answer mismatches were evaluator/scorer false negatives and are not promoted as model defects. |

## Promoted local coverage

The first-party `finance_agent_professional` v1 dataset promotes repeatable, license-safe coverage into six five-case groups:

1. bookkeeping and voucher reconciliation;
2. payroll and tax reconciliation;
3. treasury and AP/AR;
4. management analysis;
5. DOCX/PDF output with source locators;
6. RAG freshness, source trust, multi-turn memory, expiry, and deletion.

Every promoted case has a generated TaskContract, a materialized local input, private Oracle values, business assertions, a blocking deliverable validator, and deterministic checks with an expected fault domain. The zero-Provider gate must pass before a real API preview is accepted.

## Deferred to Phase 8

Large-file limits, two-hour endurance, RSS/heap trends, worker counts, cancellation cleanup, and temporary-workspace growth remain Phase 8 resource tests. They are intentionally not represented as answer-quality cases in this 30-case professional pilot.
