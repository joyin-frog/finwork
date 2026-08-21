# Finwork Finance Agent Professional v1

This is a first-party, synthetic 30-case pilot for Finwork's professional finance Agent path. It is not copied from an upstream benchmark and its scores are not comparable to public leaderboards.

The six fixture packs cover bookkeeping, payroll/tax, treasury and AP/AR, management analysis, document evidence, and policy/memory governance. Every case declares a materialized input file, private expected answers and business assertions, blocking deterministic checks, an immutable output artifact contract, and an expected fault domain.

The source records and fixtures are MIT-licensed with this repository. They contain no real company, employee, bank, tax, or customer data.

Layer 1 validates the corpus, file inputs, TaskContract materialization, Oracle privacy, artifact validator coverage, and deterministic scoring with zero Provider requests. Layer 2 must use the `finance-agent-professional` profile with one explicit fixed model after preview approval.
