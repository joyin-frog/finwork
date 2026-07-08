# 任务模板与派发对象化 Spec

> 版本 v1.1 / 2026-07-07
> 状态：已实施（计划批判 fix first→修正；实施审查裁决 ship，2026-07-07；audit 见 audit-task-templates.md）
> ⚠ 实施后修订：迁移版本号 11 → **13**（真机验证发现共享 dev 库已被并行 worktree claude/strange-mendel-cfd23e 的 v11 knowledge_embeddings / v12 audit_logs_semantics 推到 user_version=12，我方 v11 被静默跳过、五列缺失；改 13 后已在共享库应用成功）。教训见 migrations.ts v13 前的注释。
> 依赖：`spec-role-registry.md`（六角色注册表与 dispatches 表）、`spec-subagent-transparency.md`（派发事件流）、`spec-agent-team-board.md`（智能体页现状）
> 架构事实（写给没读过代码库的人）：
> - DB 是裸 SQLite（`node:sqlite`），经 `lib/db/sqlite.ts` 的 `getDb()` 单例访问；无 ORM。schema 变更走 `lib/db/migrations.ts` 的 `MIGRATIONS` 数组（`{version, name, up}`，`PRAGMA user_version` 跟踪），**当前最新 version = 10，本任务新增 version 11**。
> - 六个角色定义在 `lib/agent/roles/registry.ts` 的 `ROLE_REGISTRY`（纯数据）。主对话经 MCP 工具 `spawn_subagent`（`lib/agent/mcp-tools/subagent.ts`）派发；`lib/agent/subagent-runner.ts` 的 `runSubagent()` 起独立 `sdk.query()` 会话执行，并经 `lib/db/dispatch-store.ts` 落 `subagent_dispatches` 表（`recordDispatchStart` / `recordDispatchEnd`）。
> - dispatch 现有 status 枚举（代码约定，无 DB CHECK）：`running | success | failed`；`blocked_reason`（逗号分隔的被确认门拦截工具名）与 status 独立，blocked 的派发必然已 ended。
> - 前端"派活"按钮在 `app/agents/agent-card.tsx`，跳 `/chat/new?prompt=<文本>`；`app/chat/new/page.tsx` 把 `prompt` 参数原样填入输入框草稿，也支持 `?skill=<name>`（经 `getSkill()` 验证后合成 `/${skill.name} ${skill.starter}`）。
> - **税务专员的 filing-precheck 技能只能主对话执行**（`registry.ts:79-82` 注释：子代理无画像注入、无问用户通道），不得经 spawn_subagent 派发。
> - 测试是原生 `node:test`，统一入口 `tests/all.test.ts`（新测试文件须在其中注册）。

## 0. 目标与非目标

**目标**：
1. **任务模板**：每角色预定义 0-2 个命名任务模板（带期间参数），"派活"从自由 prompt 升级为选模板填参数；主对话的 `spawn_subagent` 能按模板 id 派发。
2. **派发对象化**：`subagent_dispatches` 记录任务模板 id、业务对象、期间，并新增复核状态机 `待锁定(pending) → 已锁定(locked)`（只进不退，人拍板才锁），为后续看板与批跑打数据地基。

**非目标（本期不做，已知并接受）**：
- 本月任务看板页（功能 3）、一键批跑与排队状态（功能 4）——本 spec 只做数据层与现有 UI 增强。
- 自动锁定、解锁、作废/重跑关联字段（重跑即新行，不建 supersede 链）。
- blocked_reason 结构化改造（维持逗号分隔工具名现状）。
- 用户自定义模板；经营分析师（analyst）暂不配模板（防"自动分析报告"门面化）。
- `listRecentDispatchActivity`（动态条）不透传新字段——动态条不展示对象化信息。

## 1. 成功标准

- [ ] `lib/agent/roles/task-templates.ts` 提供 5 个模板（见 §3 步骤 1 清单）与 `expandTaskTemplate(templateId, period, extra?)` 纯函数；未知模板 id、非法期间格式（非 `YYYY-MM`）抛错——单测覆盖成功与两条失败路径。
- [ ] `spawn_subagent` 新增可选参数 `task_template` + `period`：带 `task_template` 时 `period` 必填；模板与 `role` 不匹配时返回 isError 文本（不落 dispatch 行）；匹配时最终 instructions = 模板展开文本 + 模型补充指令——单测覆盖匹配、不匹配、缺 period 三条路径。
- [ ] 迁移 version 11 为 `subagent_dispatches` 增加 `task_template_id / business_object / period / review_status / locked_at` 五列；旧行读出时新字段为 NULL——迁移测试验证列存在与旧行兼容。
- [ ] `recordDispatchEnd` status='success' 时置 `review_status='pending'`；status='failed' 保持 NULL——单测覆盖两种结局。
- [ ] 新增 `lockDispatch(id)`：仅 `review_status='pending'` 的行可转 `'locked'`（写 `locked_at`），返回是否成功；对 locked/NULL 行返回 false 且不改动——单测覆盖三种输入。
- [ ] `POST /api/agents/dispatches/[id]/lock`：成功 200；行不存在 404；非 pending 409。
- [ ] 派活按钮变为模板菜单：有模板的角色展示模板项 + "自由派活"兜底项；subagent 型模板跳 `/chat/new?prompt=<派活话术>`（含模板名与默认当月期间）；税务专员「申报前复核」跳 `/chat/new?skill=<filing-precheck 实际注册名>`。
- [ ] 详情抽屉派发历史行展示期间/对象徽标与复核状态徽标（待锁定/已锁定），pending 行有「锁定」按钮，点击后行内状态变为已锁定。
- [ ] "等你拍板"gate 项标题在有对象/期间时带上（如「记账专员 · 结账前检查 2026-06」）。
- [ ] 全量测试跑绿：`source .venv/bin/activate && FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/roles/task-templates.ts` | 新增 | TaskTemplate 类型、TASK_TEMPLATES 数据（5 模板）、expandTaskTemplate、getTemplatesForRole、getTaskTemplate |
| `lib/db/migrations.ts` | 修改 | 追加 version 11：五列 ALTER TABLE |
| `lib/db/dispatch-store.ts` | 修改 | start/end 输入与 SQL 扩展；新增 lockDispatch；DispatchRow/BlockedDispatchRow 及对应 SELECT 增列 |
| `lib/agent/subagent-runner.ts` | 修改 | SubagentTask 增 taskTemplateId/businessObject/period 三个可选字段，透传给 recordDispatchStart |
| `lib/agent/mcp-tools/subagent.ts` | 修改 | 工具 schema 增 task_template/period；校验与模板展开；cheatsheet 列出各角色模板 |
| `app/agents/agent-card.tsx` | 修改 | 派活按钮 → 模板菜单（无模板角色保持现状单按钮） |
| `app/agents/agent-detail-drawer.tsx` | 修改 | 历史行增期间/对象/复核状态徽标 + 锁定按钮 |
| `app/api/agents/dispatches/[id]/lock/route.ts` | 新增 | POST 锁定端点 |
| `lib/domain/attention.ts` | 修改 | blockedDispatchToAttentionItem（约 245 行）签名接收 business_object/period，有值时拼入标题 |
| `app/api/agents/route.ts` | 可能修改 | 仅 blockedDispatchToAttentionItem 传参适配（131 行附近，以 tsc 为准） |
| `app/api/cockpit/summary/route.ts` | 可能修改 | 同上（45 行附近） |
| `tests/task-templates.test.ts` | 新增 | 模板展开、spawn 校验路径 |
| `tests/subagent-dispatches.test.ts` | 修改 | 迁移 11、pending/locked 状态机、lockDispatch |
| `tests/all.test.ts` | 修改 | 注册 tests/task-templates.test.ts |

## 3. 实施步骤

1. **模板数据层** `lib/agent/roles/task-templates.ts`：
   ```ts
   export type TaskTemplate = {
     id: string;                    // 全局唯一，进 dispatches 表
     roleId: string;                // 归属角色
     name: string;                  // UI 名（如「结账前检查」）
     description: string;          // 一句话，进 spawn cheatsheet 与派活菜单副标题
     mode: "subagent" | "main-skill";
     skillName?: string;            // mode=main-skill 必填
     needsFiles?: boolean;          // 派活话术提示附文件
     objectLabel?: string;          // 默认业务对象（写入 business_object）
     promptTemplate?: string;       // mode=subagent 必填，含 {{period}} 占位符
   };
   ```
   五个模板（promptTemplate 须尊重 registry.ts 各角色 rolePrompt 的边界条款，逐条对照后再写）：
   - `month-close-precheck`（bookkeeper，「结账前检查」，object「结账清单」）：核对本期凭证完整性、发票台账与入账一致性、应计提项（工资/折旧/摊销）提醒清单；产出按风险排序的检查清单，查不了的项显式列入"无法核验"，不得静默跳过。模板文本必须包含显式约束："工资计提只核查是否已有对应凭证行及金额是否与已确认期间汇总一致，不查员工明细"（对齐 rolePrompt"不读取、不推算任何员工工资明细"边界）。
   - `payroll-review`（payroll-officer，「薪资试算复核」，object「薪资期间」）：用 diff_payroll_period 与上年/上月已确认期间比对，逐人列差异项与原因猜测排最前；明确"只复核不计算、不确认期间"。
   - `filing-precheck`（tax-officer，「申报前复核」，mode=main-skill，skillName="filing-precheck"——已核实：`app/api/agents/route.ts` 按 `s.name === "filing-precheck"` 查找，技能目录 `agent-skills/skills/filing-precheck/SKILL.md` 存在）：不写 promptTemplate。
   - `bank-recon`（treasury-officer，「银行对账」，needsFiles=true，object「银行账户」）：对用户提供的流水文件与账面核对，对不上的逐笔列出（日期/金额/摘要/可能原因），多账户分列再合计。
   - `dunning-list`（receivables-officer，「催款清单」，object「应收台账」）：按账龄分级生成催款清单草稿，账龄口径显式声明。
   `expandTaskTemplate(id, period, extra?)`：校验 id 存在且 mode="subagent"、period 匹配 `/^\d{4}-\d{2}$/`，返回 `promptTemplate` 替换 `{{period}}` 后拼接 `\n\n补充上下文：${extra}`（extra 为空则不拼）。
2. **迁移** `lib/db/migrations.ts`：仿照既有迁移追加 version 11 `task-dispatch-objectify`，五条 `ALTER TABLE subagent_dispatches ADD COLUMN …`（`task_template_id TEXT`、`business_object TEXT`、`period TEXT`、`review_status TEXT`、`locked_at TEXT`）。
3. **存储层** `lib/db/dispatch-store.ts`：
   - `RecordDispatchStartInput` 增三个可选字段，INSERT 列表同步；
   - `recordDispatchEnd` 的 UPDATE 增 `review_status = CASE WHEN ? = 'success' THEN 'pending' ELSE review_status END`（failed 不动，保持 NULL）；
   - 新增 `lockDispatch(id: number): boolean`——`UPDATE … SET review_status='locked', locked_at=datetime('now') WHERE id=? AND review_status='pending'`，以 `changes>0` 为返回值；
   - 新增 `getDispatchById(id: number): DispatchRow | undefined`（lock 端点 404 判断与成功响应体都用它）；
   - `DispatchRow`、`BlockedDispatchRow` 与 `listDispatchesByRole`、`listBlockedDispatches` 的 SELECT 增 `task_template_id/business_object/period/review_status`（BlockedDispatchRow 只需 object/period）。
4. **runner** `lib/agent/subagent-runner.ts`：`SubagentTask` 增 `taskTemplateId?/businessObject?/period?`，`recordDispatchStart`（行 113 附近）透传。不改任何执行逻辑。
5. **spawn 工具** `lib/agent/mcp-tools/subagent.ts`：
   - schema 增 `task_template: z.enum(<subagent 型模板 id>).nullish()`、`period: z.string().nullish()`；注意本项目用 `zod/v4`，动态数组进 `z.enum` 需 `as [string, ...string[]]` 断言（照抄同文件 `ROLE_IDS` 的既有写法）；
   - handler 内：给了 `task_template` 时——缺 period 或格式非法 → 返回 isError 文本；模板 roleId ≠ args.role → 返回 isError 文本（两者都不落 dispatch 行，与现有"未知角色"错误路径同风格）；合法 → `instructions = expandTaskTemplate(id, period, args.instructions)`，并把 `taskTemplateId/businessObject(=objectLabel)/period` 传入 runSubagent；
   - cheatsheet 每角色行尾追加其 subagent 型模板：`；模板：month-close-precheck「结账前检查」`；工具 description 补一句"周期任务优先用 task_template 派发"。main-skill 型模板不进 enum 不进 cheatsheet。
6. **派活菜单** `app/agents/agent-card.tsx`：有模板的角色，"派活"点开列出模板项（名称+description）与"自由派活"项。subagent 型 href：`/chat/new?prompt=${encodeURIComponent(`让${role.name}执行「${t.name}」，期间 ${当前月 YYYY-MM}${t.needsFiles ? "，稍后我会提供文件" : ""}`)}`（当月由客户端 `new Date()` 算，用户可在草稿里改）；main-skill 型 href：`/chat/new?skill=${t.skillName}`；"自由派活"沿用现有 prompt。样式围绕 `app/globals.css` 既有 token，参照页面内已有下拉/弹层组件的写法，不引新依赖。
7. **详情抽屉** `app/agents/agent-detail-drawer.tsx`：历史行在现有 label/时间旁增小徽标：`period`（有则显示）、`business_object`（有则显示）、复核状态（`pending`→「待锁定」、`locked`→「已锁定」、NULL 不显示）；pending 行显示「锁定」按钮，`fetch POST /api/agents/dispatches/${id}/lock` 成功后本地更新该行。锁定不可逆，按钮需 `confirm()` 级别的二次确认（复用项目内既有确认交互模式，如无则原生 confirm）。
8. **锁定端点** `app/api/agents/dispatches/[id]/lock/route.ts`：参照 `app/api/artifacts/[id]/route.ts` 的可注入 handler 拆分模式（该路由为修复 Next 类型检查专门拆过，照抄其结构）；POST → `getDispatchById` 查无此行 404 / 非 pending 409 / `lockDispatch` 成功后 200 返回 `getDispatchById` 的更新后行。
9. **attention 标题** `lib/domain/attention.ts`：`blockedDispatchToAttentionItem`（约 245 行，注意其行参数类型是内联声明、独立于 `BlockedDispatchRow`，须同步加 object/period 字段）在有对象/期间时把标题拼为「{角色名} · {对象} {期间}」，无则维持现状。调用方 `app/api/agents/route.ts:131` 与 `app/api/cockpit/summary/route.ts:45` 传参处按新签名适配（若字段来自整行透传则可能零改动，以 tsc 为准）。
   > 澄清：`app/api/agents/dispatches/route.ts` 已确认整行序列化 `DispatchRow`，新字段自动透出，**不需改动**（reviewer 已核实），故不在 Files touched。
10. **测试**：见 §4；新文件在 `tests/all.test.ts` 注册。

## 4. 测试与验证方式

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/competent-thompson-d4dd37
source .venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# 类型检查（api 路由动过必跑）：
npx tsc --noEmit
```

- 新增测试点：
  - `tests/task-templates.test.ts`：expandTaskTemplate 三路径；每个 subagent 模板的 promptTemplate 含 `{{period}}` 占位；spawn 工具带 task_template 的匹配/不匹配/缺 period 三路径（mock 方式参照 `tests/subagent-runner.test.ts` 既有 mockSdk 惯例）。
  - `tests/subagent-dispatches.test.ts` 追加：迁移 11 后五列存在；旧行（迁移前插入）新字段 NULL；success→pending、failed→NULL；lockDispatch 三种输入；getDispatchById；listDispatchesByRole 返回新字段；**listBlockedDispatches 返回 business_object/period**（blocked 行写入后可读出，保障 attention 标题的数据路径）。
- 明确不需要：e2e、UI 快照测试（本仓库无此设施）；`listRecentDispatchActivity` 不改不测。

## 5. 风险与开放问题

- **模板 promptTemplate 与角色边界冲突**：模板文本若与 rolePrompt 边界条款矛盾（如让薪税专员"计算"），子代理行为不可预期。步骤 1 已要求逐条对照；实施审查请重点审五段模板文本。
- **`review_status` 无 DB CHECK 约束**：SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 CHECK，与既有 `status` 列同样靠应用层严守（本项目既有惯例，已接受）；写路径只有 `recordDispatchEnd` 与 `lockDispatch` 两处。
- **每次成功派发都产生 pending 行**：复核状态只在抽屉内展示，不进"等你拍板"（防噪音）——这是有意取舍；若用户觉得"锁定"无处发现，属功能 3 看板的职责，本期不修。
- **spawn 工具 enum 动态性**：`task_template` 的 enum 由模板表静态生成即可（模板不受角色停用影响——停用校验在 role 维度已有，模板校验只做归属匹配）。
