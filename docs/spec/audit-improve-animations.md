Files changed

- `app/components/ask-user-card.tsx`
- `app/components/tool-call-step.tsx`
- `app/config/general/updater-settings.tsx`
- `app/globals.css`
- `app/shared/app-nav.tsx`
- `app/shared/global-search-dialog.tsx`
- `app/shared/global-shortcuts.tsx`
- `app/shared/motion-presets.ts`
- `app/shared/resizable-preview-panel.tsx`
- `components/ui/accordion.tsx`
- `components/ui/badge.tsx`
- `components/ui/button.tsx`
- `components/ui/message-scroller.tsx`
- `components/ui/navigation-menu.tsx`
- `components/ui/progress.tsx`
- `components/ui/switch.tsx`
- `components/ui/tabs.tsx`
- `components/ui/toggle.tsx`
- `tests/agent-board.test.ts`
- `tests/all.test.ts`
- `tests/animation-motion-contract.test.ts`
- `plans/038-restrict-primitive-transitions.md` through `plans/044-animate-preview-panel-continuity.md`
- `plans/README.md`

# Animation improvement implementation audit

## Scope completed

- Replaced broad `transition-all` usage in the seven audited shared primitives with explicit animated properties.
- Preserved the mouse-triggered 100ms global-search animation while making keyboard and semantic-shortcut invocation and dismissal instant.
- Removed auto-height tweening from tool details, added reduced-motion behavior to tool details and ask-user cards, shortened message-scroller exit, and removed send-button scaling for reduced motion.
- Moved shared and updater progress animation to clamped `scaleX` transforms and retained clamped ARIA progress semantics.
- Replaced sidebar width tweening with immediate layout width plus transform/opacity choreography. Collapsed navigation is inert and aria-hidden. Added a shared active pill and interruptible pinned/recent reveals.
- Converted Motion presets to complete transform strings.
- Added presence-based preview/list choreography using pop-layout so exiting nodes do not distort flex geometry. Dragging and reduced-motion paths use zero-duration transitions.

## Verification

- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/animation-motion-contract.test.ts` — passed.
- `npm run typecheck` — passed.
- `npm run lint` — passed with 0 errors; existing repository warnings remain.
- `FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_MOCK_AGENT_DELAY=0 SKIP_LLM=true npm test` — passed after updating the stale maximize source contract to the new presence-based layout contract.
- `npm run build` — passed. Existing CSS optimizer and lint warnings remain non-blocking.

## Boundaries

- No dependency changes.
- No route, shortcut mapping, preview resize math, persisted sidebar width, conversation ordering, or chat content behavior changes.
- `workers/.venv` is an existing untracked local environment and is intentionally excluded.
