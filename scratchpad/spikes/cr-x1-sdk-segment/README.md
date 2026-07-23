# CR-X1 Spike — SDK segment / interrupt / resume controls

Evidence-only. Does **not** modify `lib/agent/claude-adapter.ts`, query-stages, agent API, or UI.

## Environment

| Item | Value |
|------|--------|
| Spike ID | CR-X1 |
| SDK (pinned here) | `@anthropic-ai/claude-agent-sdk@0.3.193` (lockfile resolves `^0.3.187` → 0.3.193) |
| Platform (authoring host) | Darwin arm64 |
| Node | see `npm run e0` output |

## How to run

```bash
cd scratchpad/spikes/cr-x1-sdk-segment
npm install          # installs SDK 0.3.193 locally under this folder
npm run all          # E0–E6 dry-run / free probes (default)
```

### Individual experiments

```bash
npm run e0   # type + runtime API surface (free)
npm run e1   # interrupt during generation
npm run e2   # interrupt vs subprocess kill
npm run e3   # maxTurns boundary
npm run e4   # streamInput timing
npm run e5   # repeated resume ×3
npm run e6   # quiesce invariant
```

### Live SDK burns (paid)

Only when you explicitly opt in:

```bash
RUN_LIVE=1 ANTHROPIC_API_KEY=sk-... npm run all
# or
RUN_LIVE=1 ANTHROPIC_API_KEY=sk-... npm run e1
```

`SKIP_LLM=true` always forces dry-run even if `RUN_LIVE=1`.

## What each experiment does without a key

| ID | Free / dry-run behavior |
|----|-------------------------|
| E0 | Import SDK, scan `sdk.d.ts`, list Query methods, optional `supportedCommands` + `interrupt`/`close` control probe |
| E1 | Timeline template + type expectations; no model call |
| E2 | Local Node child writer + SIGTERM ownership probe; SDK tool interrupt marked not_run |
| E3 | Documents `error_max_turns` / `session_id` / `resume` type contract |
| E4 | Documents `streamInput`, `priority`, `shouldQuery` type contract (AR5) |
| E5 | Documents resume/forkSession type contract + adapter pattern notes |
| E6 | Local file-hash quiesce after SIGKILL for a kill-timeout window |

## Outputs

- `evidence/E*.json` — per-experiment structured evidence
- `timelines/E*.json` — event timelines / planned steps
- Repo findings doc: `docs/spec/spike-sdk-segment-control-findings.md`

## Constraints

- Do not implement auto-segmentation product feature from this spike.
- Do not change production adapter/UI from these scripts.
