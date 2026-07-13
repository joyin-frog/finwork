# 041 — Keep progress motion on the compositor

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 3 files, small

## Problem

`components/ui/progress.tsx:24` uses `transition-all`; `app/config/general/updater-settings.tsx:149-152` animates inline `width` with `transition-all`, forcing layout on download updates.

## Target

Both indicators use an invariant full-width element with `transform: scaleX(progress / 100)`, `transform-origin:left`, and `transition-transform 200ms cubic-bezier(0.23, 1, 0.32, 1)`. Clamp values to 0–100. Reduced motion removes the transform transition but still displays the correct value.

## Steps

1. Update shared Progress.
2. Update updater download indicator to the same pattern.
3. Add a test for clamping and absence of `width`/`transition-all` animation.

## Boundaries

- Do not change progress semantics or labels.
- Do not add dependencies.

## Verification

- Typecheck, lint and tests pass.
- At 10% playback progress advances smoothly without resizing its parent; reduced motion updates instantly.
