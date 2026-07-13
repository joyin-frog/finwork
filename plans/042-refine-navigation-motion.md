# 042 — Refine navigation motion and continuity

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: MEDIUM
- **Category**: Performance and missed opportunities
- **Estimated scope**: 2 files, medium

## Problem

`app/shared/app-nav.tsx:228-239` animates the full sidebar's width. Primary selection at `:251-270` swaps background classes with no spatial continuity. Pinned/recent sections at `:280-319` rotate chevrons but mount/unmount list content abruptly.

## Target

- Sidebar collapse must not animate layout width frame-by-frame. Use transform/opacity for the visual exit and apply the final width state without a tween; 200ms maximum, `cubic-bezier(0.23,1,0.32,1)`.
- Add one shared active indicator using `motion.span layoutId="nav-active-pill"`, with `initial={false}` and `{type:"spring", duration:0.5, bounce:0.2}`. Reduced motion switches it instantly.
- Pinned/recent sections gain an interruptible <=200ms reveal. Reduced motion is instant. Do not animate while conversation rows stream/reorder.

## Repo conventions to follow

Use the existing `useReducedMotion` at line 84 and semantic background tokens. Preserve the comment that row layout motion and CSS transform must not compete.

## Steps

1. Replace width transition with a compositor-friendly collapse choreography.
2. Add a single active-pill renderer shared by primary links.
3. Add a reusable collapsible-section wrapper for pinned/recent lists.
4. Extend navigation tests for active state, collapse and reduced motion.

## Boundaries

- Do not change routes, persisted width, resizing, conversation ordering or menu actions.
- No new dependency.

## Verification

- Typecheck, lint, tests and navigation/chat e2e pass.
- At 10% playback active background travels between destinations; rapid section toggles retarget cleanly; dragging remains immediate.
