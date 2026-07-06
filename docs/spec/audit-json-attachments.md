# Audit: json-attachments

## Files changed

| File | Action |
|------|--------|
| `app/api/agent/query/route.ts` | Modified: extracted `saveAttachmentBuffer` helper; added disk-save loop in `parseJsonRequest` |
| `tests/agent-attachments-json.test.ts` | Created: 4 integration checks via `POST` handler |
| `tests/all.test.ts` | Modified: appended `agentAttachmentsJsonTestPromise` import at end |

## Changes per file

### app/api/agent/query/route.ts

**Extracted `saveAttachmentBuffer(conversationId, fileName, buffer)`** — a private function that takes the decoded `Buffer`, ensures the `upload/` directory exists under `getConversationFilesDir(conversationId)`, writes via `uniqueFilePath`, and returns the absolute path. Both `parseMultipartRequest` and `parseJsonRequest` call this function so the directory layout and naming logic are identical.

**Modified `parseMultipartRequest`** — removed the inlined `mkdirSync(uploadDir)` + `uniqueFilePath` + `writeFileSync` calls; replaced with a single call to `saveAttachmentBuffer`. Behavior is unchanged; this is pure deduplication.

**Modified `parseJsonRequest`** — replaced the original single-line return with a loop over `rawAttachments`. For each attachment where `!att.storagePath && att.dataUrl` and the decoded buffer has length > 0: auto-creates a conversation when `conversationId` is absent (mirroring multipart logic), calls `saveAttachmentBuffer`, and pushes the updated attachment (with `storagePath` and `size` set) into the result list. Attachments that already have `storagePath` or have an empty `dataUrl` pass through unchanged.

`parseJsonRequest` remains a non-exported `async function` to comply with Next.js route-file constraints (only HTTP verb handlers may be exported; exporting additional symbols breaks the `.next/types/` auto-generated constraint check).

### tests/agent-attachments-json.test.ts

Four integration checks that call `POST` directly (same pattern as `tests/smoke.test.ts`), with `FINANCE_AGENT_MOCK_AGENT=1` so no LLM calls are made. Each check uses a fresh `FINANCE_AGENT_APP_DATA_DIR` and `FINANCE_AGENT_DB_PATH` pointing to a temp directory.

- **A1**: JSON body with a `dataUrl` attachment (no `storagePath`) → POST succeeds, `upload/` dir exists under the conversation dir, exactly one file present, content matches decoded base64.
- **A2**: No `conversationId` in the request → conversation auto-created, file still appears on disk.
- **A3**: Attachment already has `storagePath` (pre-existing file on disk) → no duplicate file created, original file is preserved.
- **A4**: Attachment with empty `dataUrl` → no file written (upload dir either absent or empty).

### tests/all.test.ts

Appended at the end (after `policyRulesTestPromise`):
```typescript
const { agentAttachmentsJsonTestPromise } = await import("./agent-attachments-json.test.ts");
await agentAttachmentsJsonTestPromise;
```

## Deviation from plan

The plan said "export `parseJsonRequest`" for direct test access. Exporting it from a Next.js route file breaks the auto-generated `.next/types/` constraint (which is included in `tsconfig.json`) and adds 1 new TS error that was absent before. The test was restructured to call `POST` via a synthetic `Request` object instead — this is the "(or via Request object)" fallback the plan explicitly permitted. Behavior coverage is equivalent: all four specified test scenarios are verified.

## Red → green evidence

**Red state** (before implementation, using original `parseJsonRequest`):

Running the test at red state (before implementation) would show A1 failing: after POST, `upload/` dir would not exist because `parseJsonRequest` returned attachments with dataUrl but no storagePath and no disk write. Demonstrated with the first test iteration of the new file, which verified no `upload/` dir was created by the original code.

**Green state** (after implementation):

```
agent-attachments-json: all 4 checks passed ✓
ok 1 - tests/agent-attachments-json.test.ts
# tests 1  # pass 1  # fail 0
```

Full suite (`npm test`): `pass 11, fail 0`. Pre-existing leaked unhandledRejection from `tests/chat-float.test.ts` (A3 chat-page/markdown-message assertion) is unrelated to this change and existed before.

## TypeScript

- Errors before change: 954
- Errors after change: 960
- New errors: 6 — all are `TS5097` ("import path can only end with .ts extension") in `tests/agent-attachments-json.test.ts`, matching the pre-existing pattern across all test files in the codebase. Zero new errors in `app/api/agent/query/route.ts`.

## Lint

`eslint app/api/agent/query/route.ts`: 0 errors, 2 pre-existing warnings (`statSync`, `sanitizeFileName` unused imports — not introduced by this change).

## Open risks

1. The `sanitizeAttachments` guard in `POST` (line 79) filters attachments by `storagePath` against the conversation dir. Because `parseJsonRequest` now sets `storagePath` before `sanitizeAttachments` runs, the newly saved files pass the guard normally (they are inside the conversation dir). No bypass risk.
2. The `conversationId` auto-created in `parseJsonRequest` may differ from the one that `POST` would normally create (line 94). In practice, if `lastUserContent` is non-empty, `POST` would skip creating a new conversation and reuse `conversationId` returned by `parseJsonRequest`. This is correct behavior — the two creation paths are guarded by `if (!conversationId)` in both cases.
3. Empty-dataUrl attachments (A4) still reach `buildAttachmentBlocks` in `claude-adapter` without a `storagePath`. This maintains existing behavior for text-only/no-content attachments — they continue to be described in the prompt text rather than sent as file blocks.
