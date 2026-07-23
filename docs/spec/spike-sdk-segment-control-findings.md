# Spike Findings：Claude SDK 自动分段 / 暂停 / 恢复控制点

> ID：CR-X1  
> 状态：Completed (evidence-only)  
> 日期：2026-07-21  
> 对应：`docs/spec/spike-sdk-segment-control.md`  
> 脚本：`scratchpad/spikes/cr-x1-sdk-segment/`

## Decision: **PARTIAL**

**Live evidence missing** for E1/E3/E4/E5 (no `RUN_LIVE` + no billed model calls in this run).  
Type-level + free local probes are enough to **reject auto-segmentation** and to **allow only an explicit-user-resume follow-up** (aligned with spike PARTIAL outcome / CR-R2 v1).

Not **PASS**：cannot stand up `spec-run-auto-segmentation.md` (segment boundary, interrupt/kill order, quiesce, seamless same-run continue are unproven in live SDK behavior).  
Not full **FAIL**：SDK *does* expose `resume` / `error_max_turns` / `interrupt` / `streamInput` as typed controls; finwork already resumes via `options.resume` on a **new** `query()` — so “user continues same Claude session” remains a credible explicit path once live-validated.

---

## SDK / platform pin

| Field | Value |
|-------|--------|
| Root `package.json` range | `@anthropic-ai/claude-agent-sdk`: `^0.3.187` |
| Root `package-lock.json` resolved | `0.3.193` |
| Spike local install | `scratchpad/spikes/cr-x1-sdk-segment` → **0.3.193** |
| Types file | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (spike copy) |
| Platform | Darwin arm64 (`darwin 25.1.0`) |
| Node | v24.13.0 |
| Model (live) | not run |
| Live gate | `RUN_LIVE` unset; `SKIP_LLM=true` for runner; no `ANTHROPIC_API_KEY` in spike process env |

---

## API surface (E0 — ran)

All required CR-X1 symbols present in `sdk.d.ts` **and** on the runtime `Query` prototype:

| Control | Type | Runtime |
|---------|------|---------|
| `Query.interrupt()` | yes (`sdk.d.ts` ~2205) | yes |
| `Query.streamInput(...)` | yes (~2439) | yes |
| `Query.close()` | yes (~2466) | yes |
| `Options.maxTurns` | yes (~1603) | n/a (option) |
| `Options.resume` | yes (~1728) | n/a |
| `Options.abortController` | yes (~1252) | n/a |
| `Options.persistSession` / `forkSession` | yes | n/a |
| `SDKResultError.subtype` includes `error_max_turns` | yes (~3926) | n/a |
| `TerminalReason` includes `max_turns`, `aborted_streaming`, `aborted_tools` | yes (~6458) | n/a |
| `SDKUserMessage.priority`: `'now' \| 'next' \| 'later'` | yes (~4220) | n/a |
| `SDKUserMessage.shouldQuery` | yes (~4227) | n/a |

Critical type constraints:

1. **Control requests (including `interrupt`) are only supported when streaming input/output is used** (`Query` interface preamble ~2197–2199). Several methods also say “Only available in streaming input mode.”
2. `query({ prompt })` accepts `string | AsyncIterable<SDKUserMessage>`; **string prompt ≠ streaming input mode**.
3. Current production `lib/agent/claude-adapter.ts` uses **string/array prompt + `AbortController`**, passes `resume` / `maxTurns: 30`, and does **not** call `Query.interrupt()` or keep an open `streamInput` (read-only verification; not modified).

Free control-channel probe: `supportedCommands()` timed out at 15s in this environment (CLI spawn/auth likely); `interrupt()` and `close()` still completed without throw. Evidence: `scratchpad/spikes/cr-x1-sdk-segment/evidence/E0-api-surface.json`.

---

## Per-experiment evidence

### E1 — Interrupt during model generation

**Status: not run (live)** — reason: `RUN_LIVE` not set; no API key in spike env; `SKIP_LLM` on runner.

Type expectations recorded in `evidence/E1.json` / `timelines/E1.json`:

- Prefer `AsyncIterable` prompt then `interrupt()` after first partial/assistant event.
- Alternate cancel path: `Options.abortController` (what adapter uses today).
- Possible terminal markers: `aborted_streaming` / `aborted_tools` (typed, not observed live).

**Gap:** last event subtype, session resume-after-interrupt, and string-prompt vs streaming-input interrupt effectiveness — all unproven.

### E2 — Interrupt during run_python / long subprocess

**Status: PARTIAL (local free probe ran; SDK tool interrupt not run live).**

Local probe (`evidence/E2.json`):

- Spawned Node child appending to a marker file.
- After ~600ms: `SIGTERM` → exit `{ signal: "SIGTERM" }`.
- Marker bytes did **not** grow after kill.

**Conclusion (host):** subprocess lifecycle / file-write quiesce is **host-owned**. SDK type docs for `interrupt()` do not claim to kill in-flight Bash/Python children. Product pause must explicitly kill `run_python`/LO children; do not assume SDK interrupt is sufficient.

### E3 — maxTurns boundary

**Status: not run (live)** — same gate reason.

Type contract (`evidence/E3.json`):

- `maxTurns` stops the query; result subtype **`error_max_turns`**; `TerminalReason` may be `max_turns`.
- `SDKResultError` still carries `session_id` → type allows a subsequent `query({ options: { resume: sessionId } })`.
- **Open question (blocks PASS):** whether resume after `error_max_turns` continues cleanly **without** injecting a synthetic user “continue” message.

Adapter today: `maxTurns: 30`, resume via `resume: claudeSessionId`, stale-session rebuild on “No conversation found”.

### E4 — streamInput continuation (AR5)

**Status: not run (live)** — same gate reason.

Type contract (`evidence/E4.json`) — strongest *typed* hint for AR5 timing:

- `streamInput(AsyncIterable<SDKUserMessage>)`.
- `priority?: 'now' | 'next' | 'later'` — delivery scheduling knobs exist in types; **runtime mapping unknown**.
- `shouldQuery?: false` — append without triggering a turn; merge into next querying user message.

**ROADMAP AR5** still blocked on live timing: current turn after tools vs next model request vs reject.

Adapter today does not keep a live open input stream per run.

### E5 — Repeated resume ×3

**Status: not run (live)** — same gate reason.

Type/adapter notes (`evidence/E5.json`):

- `resume`, optional `forkSession`, `sessionId` mutual exclusion rules.
- Helpers: `listSessions` / `getSessionInfo` / `getSessionMessages` / `forkSession`.
- Triple resume transcript integrity, usage double-count, tool idempotency — **unproven**.

### E6 — Quiesce invariant

**Status: PARTIAL (local free probe ran; combined SDK interrupt+event freeze not run live).**

Local probe (`evidence/E6.json` / `timelines/E6.json`):

- Watched file hash changed while writer ran.
- After `SIGKILL`, hashes stayed **stable** for 1500ms kill-timeout window (`stableAfterKill: true`).

**Conclusion:** host-side quiesce of writers is achievable after hard kill. Full product invariant (no further SDK model/tool events + no file mutation after pause commit) still needs live E1+E2+E6 together.

---

## Allowed follow-ups vs vetoed approaches

### Allowed

1. **Explicit user resume** on a **new** `query()` with `options.resume = sessionId` (and existing stale-session rebuild). Live-validate E3/E5 before productizing budget-pause → resume UX.
2. **AR5 spike continuation (live only):** keep `AsyncIterable` prompt open; measure `streamInput` + `priority` / `shouldQuery` delivery timing; then decide steering UI.
3. **Host kill + checkpoint** as hard requirements for any pause path (budget or user stop): kill Python/LO children, freeze event cursor, hash deliverables (E2/E6 local evidence).
4. Distinguish stop reasons in *product* state machine using typed signals where available (`error_max_turns`, abort/`aborted_*`, user cancel via AbortController) — still map carefully; do not invent SDK subtypes.

### Vetoed (until live PASS evidence)

1. **Automatic seamless 240-turn (or any) segment continue** without user action / without proven interrupt→quiesce→resume sequence.
2. Claiming **same in-flight Query** continues across segment boundaries (SDK model is new `query()` + `resume`, not “segment inside one Query”).
3. Relying on **`Query.interrupt()` alone** to stop tool subprocess writes.
4. Using **string-prompt mode** and assuming control-channel `interrupt` / mid-run `streamInput` semantics hold (types say streaming I/O required).
5. Building a **second agent loop** or replacing the SDK to own turns (out of spike scope; still vetoed as product shortcut).
6. Shipping **auto-segmentation product feature** or modifying production adapter/UI from this spike.

---

## Relation to ROADMAP AR5

AR5-spike premise confirmed at type level: steering path is `streamInput` + `interrupt` under streaming input, not “poll a queue after each tool in our loop.”  
Delivery **timing** remains unverified → AR5 implementation package stays blocked; UI shape question remains post-spike.

---

## How to obtain live evidence later

```bash
cd scratchpad/spikes/cr-x1-sdk-segment
npm install
RUN_LIVE=1 ANTHROPIC_API_KEY=sk-... npm run all
# or per experiment: npm run e1 / e3 / e4 / e5
```

Re-open this findings file and upgrade PARTIAL → PASS only if E1–E6 live timelines show stable interrupt, maxTurns resume without fake continue (or document required continue), streamInput timing, triple resume integrity, and quiesce with no post-pause events/files.

---

## Artifacts

| Path | Role |
|------|------|
| `scratchpad/spikes/cr-x1-sdk-segment/README.md` | How to run |
| `scratchpad/spikes/cr-x1-sdk-segment/e0-…e6-*.mjs` | Experiment scripts |
| `scratchpad/spikes/cr-x1-sdk-segment/run-all.mjs` | Orchestrator |
| `scratchpad/spikes/cr-x1-sdk-segment/evidence/*.json` | Structured evidence |
| `scratchpad/spikes/cr-x1-sdk-segment/timelines/*.json` | Event / planned timelines |
| `docs/spec/spike-sdk-segment-control-findings.md` | This document |

Production paths **not** modified: `lib/agent/claude-adapter.ts`, query-stages, `app/api/agent/**`, UI, settings.
