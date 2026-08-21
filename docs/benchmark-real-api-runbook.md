# Real API Benchmark Runbook

This runbook is the operational companion to
[`spec-real-api-benchmark-execution.md`](./spec/spec-real-api-benchmark-execution.md).
The Spec remains the implementation and acceptance contract.

## 1. Import and materialize local datasets

The repository does not download or redistribute benchmark datasets. Obtain each dataset from its
authoritative source, review its license, then import the local JSON or JSONL file:

```bash
pnpm benchmarks:import -- \
  --dataset finqa \
  --version <version> \
  --split test \
  --source <local-source.json> \
  --ack-license
```

Repeat for `tatqa`, `financebench`, and `spreadsheetbench_v2`. Materialize each import before any
real run:

```bash
pnpm benchmarks:materialize -- \
  --import-dir <import-output-directory> \
  --assets-root <local-dataset-assets-directory> \
  --ack-license
```

Materialization verifies the import/source hashes, puts file inputs in ArtifactStore, and sends RAG
sources through Retrieval v2. When the Goal checkpoint exists, the command also registers the exact
import manifest, normalized cases file, and materialization manifest in Goal state. The real runner
reads only those registered paths; it does not scan arbitrary dataset directories.

For `benchmark-smoke`, the registered materializations must contain at least:

- FinQA: 2 cases
- TAT-QA: 2 cases
- FinanceBench: 2 cases
- SpreadsheetBench v2: 1 case

## 2. Run free gates before paid requests

Static preflight never sends a model request:

```bash
pnpm eval:benchmarks:preflight -- --mode static
```

The connection preview also remains zero-network even though all real-API consent and budget gates
must be present:

```bash
FINWORK_ALLOW_REAL_API_BENCHMARKS=1 \
pnpm eval:benchmarks:preflight -- \
  --mode connection-smoke \
  --preview \
  --confirm-real-api \
  --max-input-tokens 2000 \
  --max-output-tokens 128 \
  --max-wall-ms 120000
```

Check that the result has `ok: true` and `networkRequests: 0`. A receipt binding the provider host,
fast/reasoning model IDs, and budgets is written to the Phase 4 Goal directory. Then remove only
`--preview` to send the two minimal requests. The paid command refuses a missing, changed, or
tampered receipt, so settings or budget changes require a new preview. Both the fast and
reasoning probes must return the configured exact model ID, a unique nonce, and valid usage. The resulting report is always
`publishable: false` and is registered in the Phase 4 Goal checkpoint.

## 2.1 Keep the three evaluation layers separate

The same report must not mix these three questions:

1. **Harness** — deterministic, zero-provider tests for TaskContract, budgets, timeout/retry,
   security, evidence, validation, immutable delivery, accounting and resume. Run
   `pnpm eval:benchmarks:harness`.
2. **Agent** — fixed-model production Agent runs for retrieval/citation and artifact/tool cases.
   The runner disables the paid/adaptive Router and forces the explicit model onto both the main
   session and every subagent. Use `--layer agent --fixed-model <id>`.
3. **Model** — answer-only QA comparisons. The runner sends one direct provider completion with no
   Router, Pi loop, tools, memory, repair or delivery Harness. Use
   `--layer model --fixed-model <id>`. Build a repeated candidate plan first with
   `pnpm eval:benchmarks:model-matrix -- --models <a,b> --repetitions 2 --profile benchmark-smoke --max-cases 7`.

The model-matrix command is preview-only (`networkRequests: 0`). Every generated cell still needs
its own real-run preview, explicit consent and budgets. Agent and model runs are recorded with
`evaluationLayer` and `fixedModel` in their configuration; do not aggregate them into one score.

## 3. Preview and run the seven-case product smoke

The full data/config preview is also zero-network:

```bash
FINWORK_ALLOW_REAL_API_BENCHMARKS=1 \
pnpm eval:benchmarks:real -- \
  --profile benchmark-smoke \
  --preview \
  --confirm-real-api \
  --max-cases 7 \
  --max-input-tokens 120000 \
  --max-output-tokens 20000 \
  --max-wall-ms 1800000
```

After it passes, remove only `--preview`. The runner refuses to start unless the persisted Phase 4
connection report proves both model probes passed. Cases run sequentially through the production
Agent, TaskContract v3, tools, Security Kernel, Resource Governor, ArtifactStore, EvidenceLedger,
validators, and delivery gate.

For artifact cases, the public execution contract tells the Agent the exact required logical name
and media type. Private golden files, answer ranges, expected answers, and scorer-only validators
remain outside the Agent prompt, attachments, tool context, and production task contract.

If pricing is configured, both preview and real commands additionally require
`--max-cost-usd <amount>`.

To measure Finwork Agent capability rather than the mixed seven-case smoke, add:

```bash
  --layer agent \
  --fixed-model <exact-model-id>
```

The profile still deterministically selects the registered seven cases, then the layer boundary
keeps only governed retrieval/citation and artifact/tool cases. The preview prints the exact final
case IDs and remains zero-network.

## 4. Stop and resume behavior

Every paid case writes `case_started` before execution and `case_finished` after scoring to:

```text
.finwork-test/benchmarks/goal/spec-real-api-benchmark-execution-v1/runs/<runId>/events.jsonl
```

The run stops on the Spec's hard conditions, including auth/model errors, resource budgets,
Spreadsheet delivery validation failures, and three consecutive dependency/evaluator failures.
Token and wall-time budgets are cumulative across resume; each new case receives only the remaining
budget and cannot start after a persisted run has exhausted it. Input budgets include ordinary,
cache-read, and cache-creation input tokens; reports retain those fields separately so discounted
cache billing cannot silently bypass the safety limit.
Resume a safely checkpointed run with:

```bash
<same env and budgets> pnpm eval:benchmarks:real -- \
  <same arguments> \
  --resume-run <runId>
```

If a paid case has `case_started` but no `case_finished`, the runner refuses automatic replay. First
verify Provider usage and the persisted production run manually, then add
`--confirm-unknown-case-reviewed` to authorize that specific replay. The authorization is itself
persisted before another request is made.

Reports never contain the API key or auth headers. License status, source/manifest hashes, model
slots, commit, token/latency/retry/cost state, trace/run/task IDs, artifacts, evidence, assertions,
termination, and fault domain remain reproducible in `report.json`.

## 5. Review gaps without promoting public cases

After a completed or automatically stopped run, generate review-only proposals:

```bash
pnpm benchmarks:gaps -- \
  .finwork-test/benchmarks/goal/spec-real-api-benchmark-execution-v1/runs/<runId>/report.json \
  .finwork-test/benchmarks/goal/spec-real-api-benchmark-execution-v1/runs/<runId>/gap-proposals.json
```

Every output must remain `status: proposal`. Review the persisted trace, artifacts, validators and
provider state before confirming the fault domain. Never copy public expected answers or golden
workbooks into a local professional set; rewrite only reproducible, license-clean business cases
with their own TaskContract, inputs, private oracle and deterministic assertions.
