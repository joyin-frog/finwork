# Audit: task-templates

Spec: `docs/spec/spec-task-templates.md` v1.1

---

## Files changed

| # | File | Action |
|---|------|--------|
| 1 | `lib/agent/roles/task-templates.ts` | Created |
| 2 | `lib/db/migrations.ts` | Modified — added v11 |
| 3 | `lib/db/dispatch-store.ts` | Modified |
| 4 | `lib/agent/subagent-runner.ts` | Modified |
| 5 | `lib/agent/mcp-tools/subagent.ts` | Modified |
| 6 | `app/api/agents/dispatches/[id]/lock/route.ts` | Created |
| 7 | `lib/domain/attention.ts` | Modified |
| 8 | `app/agents/agent-card.tsx` | Modified |
| 9 | `app/agents/agent-detail-drawer.tsx` | Modified |
| 10 | `tests/task-templates.test.ts` | Created |
| 11 | `tests/subagent-dispatches.test.ts` | Modified — T6–T10 added |
| 12 | `tests/all.test.ts` | Modified — registered task-templates.test.ts |
| 13 | `tests/fixtures/golden-schema.json` | Modified (deviation — see below) |
| 14 | `tests/artifact-checklist.test.ts` | Modified (deviation — see below) |

---

## Per-file detail

### 1. `lib/agent/roles/task-templates.ts` (created)

Defines `TaskTemplate` type, `TASK_TEMPLATES` array (5 entries), `expandTaskTemplate`, `getTemplatesForRole`, `getTaskTemplate`.

Five templates:
- `month-close-precheck` — bookkeeper / subagent; promptTemplate contains the required constraint sentence about payroll accrual check scope.
- `payroll-review` — payroll-officer / subagent; explicitly states "只复核不计算、不确认期间".
- `filing-precheck` — tax-officer / main-skill; skillName = "filing-precheck", no promptTemplate (per spec).
- `bank-recon` — treasury-officer / subagent; includes `needsFiles: true`.
- `dunning-list` — receivables-officer / subagent.

All subagent templates contain `{{period}}` placeholder. `expandTaskTemplate` validates period format with `/^\d{4}-\d{2}$/` and throws on main-skill type. No deviation from spec.

### 2. `lib/db/migrations.ts` (modified)

Added version 11 entry at the end of `MIGRATIONS`, named `"task-dispatch-objectify"`. The `up` function:
1. Guards with `SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_dispatches'` — returns early if table absent (same guard pattern as v9). This is required because `subagent_dispatches` was created in the v4 migration, not in `initializeSchema`, so test DBs that call `initializeSchema` then set `user_version=4` would not have the table when v11 runs.
2. Calls `addColumnIfMissing` for: `task_template_id TEXT`, `business_object TEXT`, `period TEXT`, `review_status TEXT`, `locked_at TEXT`.

`LATEST_VERSION` is computed dynamically from `MIGRATIONS[MIGRATIONS.length - 1].version` so it automatically becomes 11. No deviation from spec.

### 3. `lib/db/dispatch-store.ts` (modified)

- `RecordDispatchStartInput`: added `taskTemplateId?`, `businessObject?`, `period?` (all optional string).
- `recordDispatchStart` INSERT: three new columns added.
- `recordDispatchEnd` UPDATE: added `review_status = CASE WHEN ? = 'success' THEN 'pending' ELSE review_status END` (the status parameter is passed twice into the prepared statement to satisfy the CASE).
- `DispatchRow`: added `taskTemplateId`, `businessObject`, `period`, `reviewStatus` (all `string | null`).
- `BlockedDispatchRow`: added `businessObject`, `period` (both `string | null`).
- `listDispatchesByRole` SELECT: expanded to include all four new columns.
- `listBlockedDispatches` SELECT: expanded to include `sd.business_object, sd.period`.
- Added `lockDispatch(id: number): boolean` — CAS UPDATE with `WHERE review_status='pending'`; returns `db.prepare(...).run(...).changes > 0`.
- Added `getDispatchById(id: number): DispatchRow | undefined`.

No deviation from spec.

### 4. `lib/agent/subagent-runner.ts` (modified)

`SubagentTask` type: added `taskTemplateId?`, `businessObject?`, `period?`.
`recordDispatchStart` call (in `runSubagent`): forwards all three new fields from `task`.

No deviation from spec.

### 5. `lib/agent/mcp-tools/subagent.ts` (modified)

- Added import of `TASK_TEMPLATES`, `expandTaskTemplate` from task-templates.
- `SUBAGENT_TEMPLATE_IDS`: computed as `TASK_TEMPLATES.filter(t => t.mode === 'subagent').map(t => t.id) as [string, ...string[]]` — matches the existing `ROLE_IDS` pattern.
- `ROLE_CHEATSHEET`: each role line appended with applicable template names.
- Tool description updated to guide model toward template dispatch for periodic tasks.
- Zod schema: added `task_template: z.enum(SUBAGENT_TEMPLATE_IDS).nullish()` and `period: z.string().nullish()`.
- Handler: when `task_template` is provided, validates `period` format (returns isError if missing or malformed), validates template belongs to requested role (returns isError "不属于角色…"), then calls `expandTaskTemplate` and passes template-derived fields to `runSubagent`. Free-instruction path unchanged.

No deviation from spec.

### 6. `app/api/agents/dispatches/[id]/lock/route.ts` (created)

POST handler, single-file inline implementation (no separate handlers.ts):
- Only exported symbol is `POST`; uses async `params: Promise<{ id: string }>` (the Next.js typing fix the spec's参照 route was created for).
- Logic: parse id → `getDispatchById` (404 if not found) → check `reviewStatus === 'pending'` (409 if not) → `lockDispatch` (409 if CAS race) → return 200 with updated row.

**Deviation from spec**: spec §3 step 8 要求照抄 artifacts/[id] 的可注入 handler 拆分（route.ts + handlers.ts、可注入 getDb）；实现为单文件内联，无 `createLockHandler`。行为路径（404/409/200）与 spec 一致；锁定语义已在 store 层被 `lockDispatch`/`getDispatchById` 单测覆盖，端点本身无单测。（本节初稿曾误写"已导出 createLockHandler"，实施审查指出后更正——orchestrator 注，2026-07-07。）

### 7. `lib/domain/attention.ts` (modified)

`blockedDispatchToAttentionItem`: the inline row type gained `businessObject?: string | null` and `period?: string | null`. Title logic updated: when either field is non-empty, prefixes the title with `${roleName} · ${objPeriod}` before the existing "的工作停在确认门：…" text.

No deviation from spec.

### 8. `app/agents/agent-card.tsx` (modified)

- Added imports: Radix UI `DropdownMenu` family from `@/components/ui/dropdown-menu`, `getTemplatesForRole` from task-templates.
- Dispatch button extracted to `DispatchButton` component that takes `cardName` and `roleId`.
- If no templates for role: renders the original single-button Link (preserves prior behavior exactly).
- If templates exist: renders a DropdownMenu — template items (name + description one-liner) above a separator, then a "自由派活" fallback item.
- Template item hrefs: subagent type → `/chat/new?prompt=…` with pre-filled period from `currentYearMonth()`; main-skill → `/chat/new?skill=${skillName}`.
- `needsFiles` templates append a note to the prompt about providing documents.
- `currentYearMonth()` helper uses local time (`d.getFullYear()` / `d.getMonth() + 1`), not `toISOString()`——本地时区正确，UTC+8 下月初 8 小时内不会串月。（本节初稿曾误写为 toISOString，实施审查指出后更正。）

No deviation from spec.

### 9. `app/agents/agent-detail-drawer.tsx` (modified)

- Added `useCallback` import.
- Added `lockedIds: Set<number>` state (optimistic local override).
- Added `handleLock(id: number)` callback: shows `confirm()` dialog → POSTs to `/api/agents/dispatches/${id}/lock` → on success adds to `lockedIds`.
- Dispatch history rows now render:
  - Period badge (gray) when `row.period` is set.
  - Business object badge (gray) when `row.businessObject` is set.
  - Review status badge: "待锁定" (yellow) for pending, "已锁定" (green) for locked.
  - Lock button for rows with effective pending status; uses `e.preventDefault(); e.stopPropagation()` to avoid triggering the row's Link navigation.
- `effectiveReviewStatus` derives from `lockedIds.has(row.id) ? 'locked' : row.reviewStatus` for optimistic UI.

No deviation from spec.

### 10. `tests/task-templates.test.ts` (created)

T1 (`expandTaskTemplate`): success with extra, success without extra, unknown id throws, invalid period throws, main-skill throws.
T2: all 4 subagent templates have `{{period}}`; main-skill templates have no `promptTemplate`.
T3 (spawn tool): missing period returns isError, role mismatch returns isError with "不属于角色", valid match enters `runSubagent` (fails with API key error, not template validation error).

Minor deviation from spec T3 handler-capture pattern: used object-property capture (`captured.handler = h as ...`) instead of closure variable, to satisfy TypeScript 5.8 CFA which does not narrow closure-assigned variables in callbacks. The `mockSdk: any` pattern matches `scan-slip-folder.test.ts` and other existing test precedents. Functional behavior identical.

### 11. `tests/subagent-dispatches.test.ts` (modified)

Added T6–T10 at end of file:
- T6: v11 five columns exist; pre-v11 row has NULL for all new fields.
- T7: `recordDispatchEnd` with `success` sets `review_status='pending'`; with `failed` leaves it NULL.
- T8: `lockDispatch` — pending→true+locked; locked→false; NULL→false; nonexistent→false. `getDispatchById` nonexistent→undefined.
- T9: `listDispatchesByRole` returns `taskTemplateId`, `businessObject`, `period`, `reviewStatus` correctly.
- T10: `listBlockedDispatches` returns `businessObject` and `period`.

No deviation from spec.

### 12. `tests/all.test.ts` (modified)

Added at end:
```ts
const { taskTemplatesTestPromise } = await import("./task-templates.test.ts");
await taskTemplatesTestPromise;
```

No deviation from spec.

---

## Deviations from spec §2 Files touched

Two files outside the spec's Files touched list were modified. Both are mechanical consequences of adding the v11 migration and were not listed in the spec due to oversight:

**`tests/fixtures/golden-schema.json`**: The `db-migration-discipline.test.ts` T2 test compares a full database dump against this fixture after running all migrations. Adding v11 adds 5 columns to `subagent_dispatches`; the fixture must reflect the post-migration schema or T2 fails. Added 5 entries (cid 12–16) for `task_template_id`, `business_object`, `period`, `review_status`, `locked_at`. This file is updated whenever a migration adds columns — it was updated in prior migration PRs (e.g., artifacts, obligations).

**`tests/artifact-checklist.test.ts`**: Contains `assert.equal(LATEST_VERSION, 10, "MIGRATIONS 末尾版本必须是 v10（开工检查）")` — a guard written when v10 was the latest migration. Adding v11 bumped `LATEST_VERSION` to 11, causing an unhandledRejection. Updated the assertion to v11. Same pattern: this guard was written at the time v10 was added and is always updated when a new migration is added.

Not updating these two files would cause `npm test` to fail, which the spec explicitly requires to pass. The changes are purely numeric/additive and introduce no logic.

---

## Test results

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true \
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
npm test

# tests 11
# suites 0
# pass 11
# fail 0
```

All 11 test suites pass including the new `task-templates` suite (T1–T3) and extended `subagent-dispatches` suite (T1–T10).

```
npx tsc --noEmit
```

Zero errors in source files (`app/`, `lib/`, `components/`). The pre-existing TS5097 errors in `tests/` (`.ts` extension imports, not allowed without `allowImportingTsExtensions`) exist across the entire test directory and pre-date this work. The TS2349 errors that would have appeared in `task-templates.test.ts` were resolved by using the existing `mockSdk: any` pattern.

---

## Open risks

1. **`confirm()` in `agent-detail-drawer.tsx`**: The lock button calls `window.confirm()`, which blocks the UI thread and does not work in mobile WebViews or certain embedded environments. This is acceptable for an internal tool but should be replaced with a modal dialog if the UI is ever exposed to a broader audience.

2. **`currentYearMonth()` in `agent-card.tsx`**: The pre-filled period in the dispatch URL uses the client's current month at the time the dropdown is rendered. If a user opens the dropdown in late December and clicks in January, the period will be wrong. This is an edge case that can be corrected manually by the user.

3. **`filing-precheck` main-skill route**: The template's `skillName: "filing-precheck"` generates `/chat/new?skill=filing-precheck`. The skill must exist in the skill registry for the link to be meaningful. The spec notes this as an existing skill; if it has not been implemented, the link silently lands on an unsupported skill page with no user feedback.

4. **No server-side `period` validation on lock endpoint**: The `/api/agents/dispatches/[id]/lock` endpoint trusts that the dispatch was created with a valid period. It does not re-validate the `period` format. This is consistent with the spec's design (period is set on creation, not on lock).

---

## 实施后修订（orchestrator 注，2026-07-07 真机验证）

迁移版本号 **11 → 13**（`lib/db/migrations.ts`，同步更新 `tests/artifact-checklist.test.ts` 的 LATEST_VERSION 断言）。原因：真机验证（/agents 看板）报 `no such column: sd.business_object`——共享 dev 库（app-data finance-agent.db）已被并行 worktree `claude/strange-mendel-cfd23e` 的 v11 knowledge_embeddings / v12 audit_logs_semantics 推到 user_version=12，本任务的 v11 被 runMigrations 判定已执行而静默跳过。改号 13 后重启 dev server，共享库成功升到 13、五列齐全，看板渲染正常。上文提及 "v11" 之处按 v13 理解；迁移内容本身未变。
