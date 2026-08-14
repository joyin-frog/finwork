# General Agent Pilot v1

## Purpose

This 30-case Pilot evaluates the Finwork production Agent and Harness, not an answer-only model. It reuses the existing benchmark import, materialization, TaskContract, production executor, private Oracle, scoring, reporting, checkpoint and budget paths.

The cases are original first-party tasks informed by three public benchmark methodologies. They are not copies of upstream tasks and the resulting score is not comparable with upstream leaderboards.

## Composition

- Layer 1 Harness — 10 `toolsandbox-style` cases: state dependencies, tool choice, bounded retry, idempotency, cancellation and structured tool results. These run with controlled failures and zero provider requests.
- Layer 2 Production Agent — 12 `tau3-style` cases: grounded policy dialogue, ambiguity, clarification, multi-turn state and human decisions.
- Layer 2 Production Agent — 8 `agentdojo-style` cases: retrieval/attachment injection, path escape, secret/PII exfiltration, destructive actions, egress and spoofed completion.

The source of truth is `benchmarks/general-agent-pilot/v1/cases.jsonl`.

## Scoring contract

Expected check IDs and fault domains are private Oracle data and never cross into `BenchmarkExecutionCase` or `TaskContract`. Agent prose and self-reported assertions cannot satisfy a deterministic check. A trusted validator must derive checks from persisted tool, event, evidence, delivery, policy and resource state.

Missing or failed checks are blocking. They are attributed to the case's declared fault domain (`model`, `capability`, `dependency`, `validator`, `policy`, `resource`, or `evaluator`).

## Gates

1. Catalog gate: exactly 30 cases with a fixed 12/10/8 composition and verified bundled provenance.
2. Privacy gate: private check IDs never appear in the public execution case or TaskContract.
3. Anti-self-report gate: a fake Agent that claims completion fails 30/30 without deterministic validator output.
4. Deterministic-validator gate: a trusted test validator can pass 30/30 through the same scorer.
5. Layer 1 gate: all 10 controlled Harness probes pass with zero provider requests.
6. Fixture gate: import, partition, TaskContract, scoring and report wiring pass without provider calls.
7. Preview gate: the profile quota is exactly 30 cases; `--layer agent` deterministically selects the 20 Layer 2 cases, one fixed model, explicit token/wall/cost budgets and successful connection smoke before paid execution. Missing production deterministic validators are a blocking preview error.

## Current production limitation

Layer 2 validators derive their result from persisted chat events, tool results, EvidenceRefs, citations, delivery state and execution validation. For clarification cases, a persisted `ask_user` followed by the expected headless `HumanDecisionRequiredError` is normalized to the benchmark terminal outcome `expectedHumanDecisionStop`; this does not pretend that the production run completed work. The paid runner remains blocked whenever a selected case lacks a registered production validator.
