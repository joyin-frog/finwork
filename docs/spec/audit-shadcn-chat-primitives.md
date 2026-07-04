# Audit: shadcn 对话基础组件接入

## Files changed

- `CLAUDE.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`
- `docs/agents/domain.md`
- `docs/spec/spec-shadcn-chat-primitives.md`
- `components/ui/message-scroller.tsx`
- `components/ui/marker.tsx`
- `app/chat/chat-page.tsx`
- `app/chat/chat-preview-selection.ts`
- `app/chat/attachment-card.tsx`（后续扩展，见下）
- `app/chat/composer-skills.tsx`（后续扩展，见下）
- `app/components/ask-user-panel.tsx`
- `app/components/tool-call-step.tsx`
- `app/config/tabs.ts`（后续扩展，见下）
- `app/dev/message-scroller/page.tsx`（评估 demo，/dev 路由不进导航）
- `app/globals.css`
- `app/styles/preview.css`
- `package.json`
- `package-lock.json`
- `tests/chat-preview-selection.test.ts`
- `tests/chat-features.test.ts`
- `e2e/mock/chat-scroller.spec.ts`

## 后续扩展（在 shadcn 基元集成之上按用户当场迭代追加，非原 spec 范围）

原 spec 只覆盖滚动/marker/shimmer 三项展示层基元。以下几项是用户在同一分支上
逐步提出、当场实现并实机验证的 UI 改进，记录于此以对齐审计范围：

- **字重**：`--text-body--font-weight` 450→400,正文/加粗对比更分明。
- **统一附件卡片**（`app/chat/attachment-card.tsx` + `preview.css` + chat-page 的
  `FileTray`/`UserBubble`):图片满卡预览 + 点击 lightbox(Portal 挂 body,逃出
  MessageScrollerItem 的 content-visibility 裁剪);文件语义色卡 + 文件名 + 格式
  徽章 + 点击去预览页。删除旧 `AttachmentChip`/`ImageThumb` 与相关死代码。
  行为变更:点图片从"进预览侧栏"改为"lightbox 直接看"。
- **过程行图标**：按 6 个动作家族(检索/命令/读取/编辑/技能/询问)加淡色图标,
  父行(组摘要)不带、子行带;技能图标全局统一为 `NoteIcon`(过程行 + 技能选择
  浮层 `composer-skills.tsx` + 引用技能菜单 + 配置技能 tab `config/tabs.ts`)。

## Implementation summary

- Added `@shadcn/react@0.2.0` and upgraded `shadcn` to `4.13.0` so `shimmer` and `scroll-fade` exist in `shadcn/tailwind.css`.
- Added project-owned shadcn `MessageScroller` and `Marker` source files without overwriting the customized shared `Button`.
- Replaced the full-screen chat's custom `scrollIntoView`/stick state/button implementation with one `MessageScroller` controller.
- Kept current open-at-end and 96px live-edge behavior. New-turn top anchoring was tested and intentionally deferred because it conflicts with this app's temporary-message-to-DB-message transition.
- Preserved `threadRef` on the actual viewport for `FindInChat`.
- Replaced four `.fa-shimmer-text` consumers with official token-driven `shimmer`; removed duplicate local CSS/keyframes.
- Used `Marker` for thinking, system timeline and ask-user status rows. Interactive tool/Bash rows remain unchanged.
- Removed obsolete scroll helper, CSS and stale tests; updated the current component contract instead of retaining legacy shims.

## TDD evidence

### Slice 1 — transcript interface

- RED: `chat transcript exposes one accessible message scroller` failed because `Messages` region count was 0.
- GREEN: same test passed after the transcript migration.

### Slice 2 — live-edge behavior

- Playwright passed: live edge follows streaming output, manual scroll-away is preserved, scroll-to-latest resumes following.

### Slice 3 — find compatibility

- `chat-scroller.spec.ts` + existing `find-in-chat.spec.ts`: 4 passed, 0 failed.

### Exploratory anchor test

- Confirmed that top-anchoring a newly appended user turn did not settle correctly with the current same-commit user+assistant append and immediate final-message replacement.
- Removed the experimental turn-ID/retry workaround and updated the spec to preserve current bottom-follow semantics.

### Slice 4 — Marker/shimmer

- RED: ask-user had no announced `status` role and still used the old animation.
- Implementation compiles in Next dev and targeted TypeScript/lint checks pass.
- Final GREEN Playwright rerun is pending because the environment rejected further non-sandbox browser execution after its usage allowance was exhausted. A sandboxed retry could not start a browser/server and reported 0 executed tests.

## Verification results

Passed:

- Changed-file TypeScript project: no errors.
- Changed-file ESLint: 0 errors; 15 pre-existing warnings in `chat-page.tsx`.
- `tests/chat-preview-selection.test.ts`
- `tests/chat-features.test.ts`
- `tests/tool-call-step-ui.test.ts`
- `tests/chat-process-polish.test.ts`
- `git diff --check`
- Next dev compilation after MessageScroller and Marker changes.

Environment-blocked:

- `npm test` and `npm run typecheck` reach the CI typecheck guard but include ignored stale copies under `src-tauri/resources/` and `src-tauri/target/`. Those copies reference modules not present in the old bundle. The same errors reproduce before inspecting any changed file.
- Full chat/tool/ask-user Playwright regression rerun requires a fresh browser execution allowance.

## Follow-up verification commands

After removing or refreshing ignored Tauri build outputs through the normal build workflow:

```bash
FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_MOCK_AGENT_DELAY=0 SKIP_LLM=true npm test
npm run typecheck
npm run build
```

With the mock server running:

```bash
npx playwright test e2e/mock/chat-scroller.spec.ts e2e/mock/chat.spec.ts e2e/mock/find-in-chat.spec.ts
```
