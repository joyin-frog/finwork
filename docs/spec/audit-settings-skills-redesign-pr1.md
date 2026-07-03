# Files changed

- `agent-skills/skills/{business-analysis,contract-extract,docx,finance-analysis,kingdee-draft,payroll-calc,pdf,pptx,reimbursement-check,rnd-deduction-check,tax-incentive,xlsx}/SKILL.md`
- `lib/agent/skills-store.ts`
- `app/config/skill-catalog.tsx`
- `app/config/skill-center.tsx`
- `app/config/profile/profile-settings.tsx`
- `app/chat/new/page.tsx`
- `app/chat/chat-page.tsx`
- `tests/skills-store.test.ts`
- `tests/settings-skills-redesign.test.ts`
- `tests/all.test.ts`
- `e2e/mock/chat.spec.ts`
- `docs/spec/spec-settings-skills-redesign.md`
- `docs/spec/audit-settings-skills-redesign-pr1.md`

## 每个文件改了什么

- 12 个内置技能补充 `requires`，8 个财务能力补充 `starter`。
- 技能存储层解析并通过既有 API 暴露新展示字段。
- 新能力目录按财务节奏展示 8 张卡片，文件技能收成自动生效说明，底部只保留高级文件管理入口。
- 新聊天入口校验技能参数、预填 starter，并初始化既有 `referencedSkills` 状态；发送链未新建机制。
- 画像页删除税务优惠/研发核查咒语文案。
- 单元测试覆盖元数据、目录契约和 hint 注入；e2e 覆盖点击开始、聚焦、技能请求参数与回复完成。

## 与计划的偏差及原因

- 仓库没有 `.venv`，因此无法按计划执行 `source .venv/bin/activate`；本次相关测试不依赖 Python venv，使用现有系统环境运行。
- 全量 `npm test`、`npm run typecheck` 和 `npm run build` 被两个 gitignore 路径中的历史打包副本拖入 TypeScript 扫描并失败：`src-tauri/resources/next-server`、`src-tauri/target`。应用源码编译阶段成功，失败均为副本缺失相对模块，不是本次 diff 引入。

## 测试结果

- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/settings-skills-redesign.test.ts`：通过。
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/skills-store.test.ts`：通过。
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run test:e2e -- e2e/mock/chat.spec.ts --grep "skills catalog"`：1 passed。
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run build`：Next 应用编译成功，随后 typecheck 因上述忽略目录中的历史副本失败。
- 范围内 ESLint：无新增 error；`chat-page.tsx` 有既有 warning。
- `git diff --check`：通过。

## 开放风险

- PR-2 将基于本分支继续堆叠；PR-1 合并后需把 PR-2 rebase 到 main 或调整 base。
