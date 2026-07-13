# 043 — Use compositor-friendly Motion presets

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: MEDIUM
- **Category**: Performance and cohesion
- **Estimated scope**: 4 files, small

## Problem

`app/shared/motion-presets.ts:14-22` encodes `y` and `scale` shorthands, consumed by large Cockpit subtrees; `AskUserCard` repeats shorthand transforms. The audit standard requires full transform strings for compositor-friendly Motion animation.

## Target

Replace preset shorthand states with exact transform strings:

```ts
hidden: { opacity: 0, transform: "translateY(8px)" }
visible: { opacity: 1, transform: "translateY(0px)" }
exit: { opacity: 0, transform: "translateY(-4px)" }
```

For pop-in use `translateY(4px) scale(0.96)` to `translateY(0px) scale(1)`. Preserve existing transition objects. Update consumers/tests as needed, without changing distance or timing.

## Verification

- Typecheck, lint and tests pass.
- Cockpit at 10% playback retains the same visual geometry; Performance panel shows transform/opacity only.
