# 038 — Restrict shared primitive transitions

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 7 files, small mechanical change

## Problem

High-frequency primitives use `transition-all`, for example `components/ui/button.tsx:8`:

```tsx
"... transition-all ... active:not-aria-[haspopup]:translate-y-px ..."
```

The same broad transition appears in Toggle, Switch, Badge, Accordion, NavigationMenu and Tabs, opting borders, rings and layout properties into animation.

## Target

Replace each `transition-all` with the narrowest Tailwind property list required by that component. Buttons/toggles/tabs/navigation items animate colors and transform; Switch root animates colors while its thumb keeps `transition-transform`; Accordion animates colors only. Do not change state styles or timing. Exact allowed pattern:

```tsx
transition-[color,background-color,border-color,box-shadow,transform]
```

## Repo conventions to follow

`components/ui/input.tsx` uses `transition-colors`; `components/ui/message-scroller.tsx` demonstrates a bracketed explicit transition list.

## Steps

1. Update `components/ui/{button,toggle,switch,badge,accordion,navigation-menu,tabs}.tsx`.
2. Add or extend a source-level guard test that rejects `transition-all` in these shared primitives.

## Boundaries

- Do not change markup, variants, dimensions or colors.
- Do not add dependencies.

## Verification

- **Mechanical**: `npm run typecheck`, `npm run lint`, `npm test` all exit 0.
- **Feel check**: inspect buttons, switches, tabs and navigation menus at 10% playback; color and press feedback remain, focus-ring geometry does not tween.
- **Done when**: no `transition-all` remains in the listed primitives.
