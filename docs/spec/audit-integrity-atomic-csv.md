# Files changed

- `docs/spec/spec-integrity-atomic-csv.md`
- `docs/spec/audit-integrity-atomic-csv.md` (new)
- `docs/spec/spec-security-release-blockers.md`
- `docs/spec/audit-security-release-blockers.md`
- `lib/db/sqlite.ts`
- `lib/knowledge/storage.ts`
- `app/api/knowledge/documents/route.ts`
- `app/api/files-library/route.ts`
- `app/api/knowledge/documents/[id]/route.ts`
- `lib/knowledge/pipeline.ts`
- `tests/files-promote.test.ts`
- `tests/knowledge-storage.test.ts`
- `app/api/agent/query/route.ts`
- `lib/agent/query-stages.ts`
- `tests/atomic-multirow-writes.test.ts` (new)
- `tests/all.test.ts`
- `workers/finance_worker.py`
- `tests/fixtures/corpus/csv-blank-invoices.csv` (new)
- `tests/parse-corpus.test.ts`

## Changes by area

- Storage publication now derives one lowercase hash/extension path, writes a unique same-directory `wx` temporary file, atomically publishes it with a hard link, verifies any competing target's actual SHA-256, and always removes the temporary file.
- A `globalThis[Symbol.for("finance-agent.knowledge-ingest-leases")]` registry maintains independent hash and canonical-path reference counts. Canonical paths are resolved and NFC-normalized, with case folding only on darwin/win32. Release is idempotent.
- Both knowledge upload routes acquire hash and path leases before publication and retain them through parsing and `ingestDocument`; all exits release in `finally`. Failed unowned targets are deliberately left for future age-based GC.
- SQLite exposes reusable exact-hash and platform-canonical storage-path owner counters. Delete and same-name update paths remove files or mirrors only after the logical owner change, zero remaining owners, and no active corresponding lease.
- Assistant message/events, user message/attachments, and archive flag/obligations now use synchronous `BEGIN`/`COMMIT` with best-effort `ROLLBACK`; unarchive re-derivation uses `{ inTx: true }`.
- CSV duplicate detection ignores blank `invoice_no` values while retaining one warning for the second occurrence of a real duplicate.

## TDD evidence

- RED — `node --import tsx tests/knowledge-storage.test.ts`: a pre-existing conflicting target was silently overwritten; the expected conflict exception was missing.
- GREEN — the same test passes after atomic non-overwrite publication, hash verification, canonical path, and global lease implementation.
- RED — `node --import tsx tests/parse-corpus.test.ts`: two blank invoice numbers produced one blank “发票号重复” warning (`1 !== 0`).
- GREEN — blank identifiers produce zero duplicate warnings and duplicated `INV-001` produces exactly one.
- RED — `node --import tsx tests/atomic-multirow-writes.test.ts` Site B: attachment `RAISE(ABORT)` left one user message (`1 !== 0`).
- GREEN — Site B rolls back both message and attachment.
- RED — the same test Site C: obligation-delete `RAISE(ABORT)` left `archived = 1` (`1 !== 0`).
- GREEN — archive deletion and unarchive re-derivation failures both preserve the prior flag/obligation state.
- RED — the same test Site A through real `POST /api/agent/query?stream=false`: event `RAISE(ABORT)` left one assistant message (`1 !== 0`).
- GREEN — the real route returns the injected failure and leaves neither assistant message nor events; the previously committed user message remains.

## Test results

- PASS — `node --import tsx tests/files-promote.test.ts`
- PASS — `node --import tsx tests/atomic-multirow-writes.test.ts`
- PASS — `node --import tsx tests/parse-corpus.test.ts`
- PASS — `node --import tsx tests/python-worker.test.ts`
- PASS — `node --import tsx tests/query-stages.test.ts`
- PASS — `node --import tsx tests/obligations-live.test.ts`
- PASS — `node --import tsx tests/confirm-contract-chain.test.ts`
- PASS — `node --import tsx tests/confirm-gate-fix.test.ts`
- PASS — `node --import tsx tests/agent-confirm-flow.test.ts`
- PASS — `node --import tsx tests/sdk-pre-tool-use.test.ts`
- PASS — `node --import tsx tests/knowledge-storage.test.ts`
- PASS — `node --import tsx tests/skill-xlsx.test.ts`
- PASS — `node --import tsx tests/role-registry.test.ts`
- BLOCKED BY PRE-EXISTING GENERATED OUTPUTS — `npm run typecheck`; every diagnostic is in `src-tauri/resources/next-server` or `src-tauri/target/{debug,release}/next-server`, where stale `subagent-runner.ts` copies cannot resolve adjacent modules and infer three implicit `any` callback parameters.
- PASS — source-only TypeScript diagnostic over 427 non-Tauri source files.
- BLOCKED BY THE SAME PRE-EXISTING GENERATED OUTPUTS — `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`; the suite reaches `tests/ci-workflow.test.ts`, whose nested typecheck reports the same stale-copy diagnostics.

Source-only diagnostic command:

```bash
node -e 'const ts=require("typescript");const path=require("node:path");const cfgPath=path.resolve("tsconfig.typecheck.json");const raw=ts.readConfigFile(cfgPath,ts.sys.readFile);const host={getCanonicalFileName:x=>x,getCurrentDirectory:ts.sys.getCurrentDirectory,getNewLine:()=>ts.sys.newLine};if(raw.error){console.error(ts.formatDiagnosticsWithColorAndContext([raw.error],host));process.exit(1)}const cfg=ts.parseJsonConfigFileContent(raw.config,ts.sys,path.dirname(cfgPath));const files=cfg.fileNames.filter(f=>!f.includes(`${path.sep}src-tauri${path.sep}`));const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram(files,cfg.options));if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,host));process.exit(1)}console.log(`source-only typecheck passed (${files.length} files; excluded src-tauri stale outputs)`)'
```

## Deviations and constraints

- No implementation-scope file deviation.
- The existing user change in `src-tauri/Cargo.lock` and all ignored/generated Tauri outputs were preserved without modification.
- The external ignored plans worktree was not modified.

## Open risks

- Leases are process-local by design for the current single-Node desktop runtime. A future multi-process deployment must replace them with cross-process coordination before retaining physical deletion.
- Failed ingests may leave unowned content-addressed targets. Cleanup must be a separate age-based GC; immediate deletion is not a correctness-safe substitute.
- Owner counting prevents shared-file loss but does not enforce logical uniqueness or perform stored-row deduplication.

## Independent implementation review

- Verdict: **APPROVE**; no implementation blockers found.
- Independently re-ran storage/owner routes, Sites A/B/C atomicity, CSV, confirmation gates, native SDK hook, query/obligation, Python worker, xlsx/role tests, source-only typecheck (427 files), and `git diff --check`.
- Confirmed the prior P0 tool gate remains fail-closed and the user-owned `src-tauri/Cargo.lock` change was excluded from review and untouched.
