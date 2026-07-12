# 039 — Make keyboard-invoked dialogs instant

- **Status**: DONE
- **Commit**: 5d26309
- **Severity**: HIGH
- **Category**: Purpose and frequency
- **Estimated scope**: 3 files, small

## Problem

`app/shared/global-shortcuts.tsx:53-82` opens global search and shortcut help from keyboard events, but `app/shared/global-search-dialog.tsx:59-64` and `global-shortcuts.tsx:119-124` always apply `animate-in/out`, fade and zoom classes. A command surface used from the keyboard should respond immediately.

## Target

Track whether each dialog was opened by the global keyboard handler. For keyboard-triggered opens, render overlay/content without animation classes. Mouse-triggered global search may retain the existing 100ms fade/zoom. Closing an instant-open dialog must also be instant.

## Repo conventions to follow

Keep dialog state in `GlobalShortcuts`; pass a boolean prop rather than creating global state. Continue using existing Radix dialog markup and semantic tokens.

## Steps

1. Add trigger-source state in `app/shared/global-shortcuts.tsx` and set it in `onKeyDown` / semantic shortcut event paths.
2. Add an `instant` prop to `GlobalSearchDialog` and conditionally omit motion utility classes.
3. Cover keyboard and mouse paths in focused tests or e2e assertions.

## Boundaries

- Do not change shortcut mappings, dialog content or search behavior.
- Do not remove mouse-open animations.

## Verification

- **Mechanical**: typecheck, lint, unit suite and global-search e2e pass.
- **Feel check**: at 10% playback, Cmd/Ctrl+G and shortcut-help appear with no tween; clicking the search button retains the 100ms transition.
- **Done when**: keyboard invocation and dismissal are visually immediate.
