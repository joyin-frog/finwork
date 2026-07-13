# Files changed

- `lib/agent/tools/registry.ts`
- `lib/agent/hooks/built-in.ts`
- `lib/agent/hooks/chain.ts`
- `lib/agent/hooks/sdk-pre-tool-use.ts` (new)
- `lib/agent/claude-adapter.ts`
- `lib/agent/subagent-runner.ts`
- `tests/confirm-gate-fix.test.ts`
- `tests/agent-confirm-flow.test.ts`
- `tests/sdk-pre-tool-use.test.ts` (new)
- `tests/skill-xlsx.test.ts`
- `tests/role-registry.test.ts`
- `tests/all.test.ts`
- `app/api/files-library/route.ts`
- `tests/files-promote.test.ts`
- `lib/knowledge/storage.ts`
- `tests/knowledge-storage.test.ts`
- `lib/knowledge/pipeline.ts`
- `lib/db/sqlite.ts`
- `docs/spec/audit-security-release-blockers.md` (new)

## Changes by file

- `lib/agent/tools/registry.ts`: marks `run_python` high risk and excludes every builtin/high-risk/always-confirm tool from SDK automatic allowance while keeping builtin definitions visible through `BUILTIN_TOOLS`.
- `lib/agent/hooks/built-in.ts`: adds a user-facing `run_python` impact statement covering local file reads, modifications, and code execution; removes the inaccurate sandbox implication from the Bash denial message.
- `lib/agent/hooks/chain.ts`: changes confirmation handling to a closed exact allow-list; all empty, negative, ambiguous, or otherwise unmatched answers are denied.
- `lib/agent/hooks/sdk-pre-tool-use.ts`: adds the SDK-native `PreToolUse` mechanism gate for Bash and sensitive file tools. Security denials map to `deny`; successful checks map to `defer`; unrelated tools receive no permission decision.
- `lib/agent/claude-adapter.ts`: registers the native gate for the main Agent alongside the existing `PostCompact` hook.
- `lib/agent/subagent-runner.ts`: registers the same native gate for child Agents, which continue to have no confirmation resolver, and limits visible builtins to the explicit `BUILTIN_TOOLS + Skill` set instead of the full `claude_code` preset.
- `tests/confirm-gate-fix.test.ts`: guards that all builtins and `run_python` are absent from `ALLOWED_TOOLS`, while safe finance tools remain automatically allowed.
- `tests/agent-confirm-flow.test.ts`: covers exact affirmative confirmation, ambiguous/negative rejection, `run_python` per-call confirmation, fail-closed child-channel behavior, and risk copy.
- `tests/sdk-pre-tool-use.test.ts`: covers Bash denial, out-of-root Write denial, in-root Write defer, no decision for unrelated tools, main/child registration contracts, and the child Agent's explicit tool-set/no-preset source contract.
- `tests/skill-xlsx.test.ts`: separates builtin tool visibility from automatic allowance.
- `tests/role-registry.test.ts`: permits builtin and high-risk shared tools to remain defined while being absent from role automatic-allow collections.
- `tests/all.test.ts`: registers the new SDK gate test.
- `app/api/files-library/route.ts`: creates a content-addressed knowledge-owned copy and parses/stores that copy during promote; the v1.4 integrity follow-up now holds global hash/path leases across write, parse, and ingest and does not perform unsafe immediate failure cleanup.
- `tests/files-promote.test.ts`: replaces duplicated promote logic with real route lifecycle coverage for owned-copy deletion, original-file retention, historical external-path safety, same-name content updates, duplicate handling, invalid IDs, audit records, and empty-content ingest failure without an orphan copy. Environment overrides are restored in `finally`.
- `lib/knowledge/storage.ts`: makes `deleteStoredFile` return a boolean and delete only existing targets whose real path is strictly inside the existing knowledge root real path.
- `tests/knowledge-storage.test.ts`: covers internal deletion, missing-path no-op, external-file rejection, and symlink/junction escape rejection with explicit platform skip handling.
- `lib/knowledge/pipeline.ts`: persists new content hash/storage ownership for same-name updates and removes an old path/mirror only after the DB points to the new owner state, the corresponding owner count is zero, and no active lease exists; containment protects historical external paths.
- `lib/db/sqlite.ts`: updates `content_hash` and `storage_path` together with the rest of knowledge document metadata.

## TDD evidence

- RED: `node --import tsx tests/confirm-gate-fix.test.ts` failed because builtin `Read` remained in `ALLOWED_TOOLS`.
- RED: `node --import tsx tests/agent-confirm-flow.test.ts` failed because the ambiguous/negative answer `拒绝` was allowed.
- RED: `node --import tsx tests/sdk-pre-tool-use.test.ts` failed because the SDK-native gate module did not exist.
- RED: `node --import tsx tests/knowledge-storage.test.ts` failed because owned-file deletion returned `undefined` instead of the required boolean contract.
- RED: `node --import tsx tests/files-promote.test.ts` failed because route promote stored the original attachment path.
- Review fix RED: `node --import tsx tests/sdk-pre-tool-use.test.ts` failed because the child Agent still used the complete `claude_code` preset and did not import `BUILTIN_TOOLS`.
- Review fix RED: `node --import tsx tests/files-promote.test.ts` failed because empty-content ingest failure left the just-written knowledge copy on disk without a DB owner.
- GREEN: all five spec-directed tests pass after the minimum implementation changes.

The empty-content RED above records the superseded v1.3 contract. `spec-integrity-atomic-csv.md` v1.4 replaced immediate cleanup with dual ingest leases plus future age-based GC because a row-level owner lookup cannot prove that another request is not ingesting the same content-addressed target.

## Integrity owner follow-up

- Storage publication is atomic and non-overwriting; an `EEXIST` target is reused only after its bytes hash to the requested SHA-256.
- `storage_path` and `content_hash` cleanup is last-owner and lease aware, including shared mirrors, same-name updates, compatibility rows, and delete routes.
- Both upload routes release hash/path leases on successful and failed ingest. Failed unowned targets remain as safe orphans for future age-based GC.
- `node --import tsx tests/files-promote.test.ts` and `node --import tsx tests/knowledge-storage.test.ts` pass with the v1.4 contracts.

## Deviations from plan

- No implementation-scope deviation.
- The exact `npm run typecheck` command and the standard full test command do not complete because existing generated Tauri copies under `src-tauri/resources/next-server` and `src-tauri/target/{debug,release}/next-server` contain incomplete stale copies of `subagent-runner.ts`. Per the approved spec, these artifacts and the existing `src-tauri/Cargo.lock` change were not modified.
- An additional source-only TypeScript diagnostic excluded `src-tauri` generated outputs and passed for 427 source files. This was diagnostic evidence only and did not replace the required command. Reproducible command:

```bash
node -e 'const ts=require("typescript");const path=require("node:path");const cfgPath=path.resolve("tsconfig.typecheck.json");const raw=ts.readConfigFile(cfgPath,ts.sys.readFile);const host={getCanonicalFileName:x=>x,getCurrentDirectory:ts.sys.getCurrentDirectory,getNewLine:()=>ts.sys.newLine};if(raw.error){console.error(ts.formatDiagnosticsWithColorAndContext([raw.error],host));process.exit(1)}const cfg=ts.parseJsonConfigFileContent(raw.config,ts.sys,path.dirname(cfgPath));const files=cfg.fileNames.filter(f=>!f.includes(`${path.sep}src-tauri${path.sep}`));const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram(files,cfg.options));if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,host));process.exit(1)}console.log(`source-only typecheck passed (${files.length} files; excluded src-tauri stale outputs)`)'
```

## Test results

- PASS — `node --import tsx tests/confirm-gate-fix.test.ts`
- PASS — `node --import tsx tests/agent-confirm-flow.test.ts`
- PASS — `node --import tsx tests/sdk-pre-tool-use.test.ts`
- PASS — `node --import tsx tests/knowledge-storage.test.ts`
- PASS — `node --import tsx tests/files-promote.test.ts`
- PASS — `node --import tsx tests/skill-xlsx.test.ts`
- PASS — `node --import tsx tests/role-registry.test.ts`
- BLOCKED BY PRE-EXISTING GENERATED OUTPUTS — `npm run typecheck`; all reported diagnostics are under the three stale Tauri `next-server` copies.
- PASS — source-only TypeScript diagnostic over 427 non-Tauri source files.
- BLOCKED BY THE SAME PRE-EXISTING GENERATED OUTPUTS — `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`; the suite reaches `tests/ci-workflow.test.ts`, whose nested typecheck reports the same stale-copy diagnostics.

## Open risks

- Release smoke still needs one desktop run confirming legal Read/Write behavior and Bash denial with the real SDK/permission mode, as required by the approved spec.
- Python execution remains local process execution with per-call confirmation, not an OS sandbox; file/network/process/resource isolation remains a separate task.
- Removing builtins from `allowedTools` increases permission-path traffic. The native `PreToolUse` gate is covered in unit/contract tests, but desktop interaction regression remains the final release check.

## Independent implementation review

- Verdict: **APPROVE** after the integrity/storage owner follow-up; no implementation blockers remain.
- The reviewer independently confirmed fail-closed builtin handling, Bash denial, path-gated writes, per-call `run_python` confirmation, atomic storage publication, and lease/owner-safe deletion.
- Real desktop SDK smoke remains a documented manual release checklist item.
