# 040 — Make chat motion fast and accessible

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: MEDIUM
- **Category**: Accessibility, performance, duration, cohesion
- **Estimated scope**: 5 files, medium

## Problem

- `app/components/tool-call-step.tsx:316-340,400-416` duplicates inline timings and animates chevron rotation plus `height: 0` to `auto` without reduced-motion handling.
- `app/components/ask-user-card.tsx:62-66` springs from `y:6, scale:.98` without reduced-motion handling.
- `components/ui/message-scroller.tsx:100` exits over 400ms while translating/scaling/fading.
- `app/globals.css:466-487` retains large hover/press scaling under reduced motion and does not gate hover motion to a fine pointer.

## Target

Use `useReducedMotion()` in the two Motion components. Reduced motion removes rotation, translation, scale and height tween while retaining at most opacity for 180ms with `cubic-bezier(0.23, 1, 0.32, 1)`. Normal tool-detail motion must avoid per-frame `height:auto` layout; use an interruptible transform/opacity or grid-track CSS transition with a measured wrapper. Message-scroller entry and exit are both <=200ms. Send-button hover is gated by `@media (hover:hover) and (pointer:fine)`; reduced motion retains color/shadow feedback but no scale.

## Repo conventions to follow

Reuse `EASE_OUT_QUICK` from `app/shared/motion-presets.ts`; follow `app/cockpit/page.tsx:36,80-85` for `useReducedMotion` branching.

## Steps

1. Refactor both expansion paths in `tool-call-step.tsx` through one shared detail-motion wrapper.
2. Add reduced-motion branching to `AskUserCard`.
3. Change MessageScroller inactive duration from 400ms to <=200ms.
4. Rewrite send-button hover/reduced-motion media rules.
5. Add focused reduced-motion and source-contract tests.

## Boundaries

- Preserve tool content, expanded state, chat scrolling and submit behavior.
- Do not add dependencies.

## Verification

- **Mechanical**: typecheck, lint, test and chat e2e pass.
- **Feel check**: spam-expand tool rows; animation retargets without jumping. At 10% playback there is no transcript-wide height stutter. Emulate reduced motion: details and ask cards do not move/scale, send button does not grow.
- **Done when**: all four paths meet the target and retain behavior.
