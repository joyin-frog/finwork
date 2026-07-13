# 044 — Add preview-panel continuity

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: LOW
- **Category**: Missed opportunity
- **Estimated scope**: 2–4 files, medium

## Problem

`app/shared/resizable-preview-panel.tsx:61-94` conditionally mounts the divider and preview, while maximized mode hides the list immediately. Opening, closing and maximizing a spatially connected side panel therefore teleport. Dragging correctly needs to remain immediate.

## Target

Animate only occasional open/close/maximize transitions with transform and opacity, <=250ms using `cubic-bezier(0.23,1,0.32,1)`. The panel enters from `translateX(2%)` with opacity 0, never from off-screen; reduced motion is instant/fade-only. During `dragging`, all geometry transitions are disabled. Focus must remain valid when closing/maximizing.

## Steps

1. Add presence/choreography to `ResizablePreviewPanel` without transferring state ownership.
2. Preserve separator and width calculation contracts.
3. Add component/e2e coverage for open, close, maximize and reduced motion.

## Boundaries

- Do not change `usePreviewResize` persistence or drag math.
- Do not animate drag updates or introduce a dependency.

## Verification

- Typecheck, lint, tests and preview e2e pass.
- At 10% playback open/close explains direction; drag tracks the pointer exactly; reduced motion has no position movement.
