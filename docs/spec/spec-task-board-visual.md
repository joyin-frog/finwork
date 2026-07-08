# 看板视觉刀 Spec（富卡片网格 + 批跑入口 + 派发文件字段）

> 版本 v1.1 / 2026-07-08
> 状态：已实施（计划批判 fix first→修正；实施审查 ship；真机验证过（亮/暗），照出三缺陷已修——见 audit 尾注，2026-07-08）
> 依赖：`spec-task-board.md`（看板骨架）、`spec-filing-precheck-batch.md` / `spec-bank-recon-batch.md`（两个批跑工具）、`spec-task-templates.md`（对象化五列）
> 架构事实（写给没读过代码库的人）：
> - 设计 token 在 `app/globals.css`：状态色 `--tone-ok/--tone-warn/--tone-notice/--tone-alarm/--tone-neutral`（`--tone-analysis` 属"搭配色"块但既有代码已用于 running 态，沿用）；卡片 `--card/--border/--card-lift/--card-ring/--radius*`；utility 类 `.fa-tone-pill`（状态胶囊，容器上 `style={{ "--tone": "var(--tone-xxx)" }}`）、`.fa-toned`（wash 底）、`.fa-tone-edge`（左侧色条）。暗色主题经 `.dark` class 全量覆盖 token——**只用 token 不写死颜色即自动适配暗色**。
> - 卡片外壳惯例：`<Surface level="card" edge="hairline" shape="card|control">`（参照 `app/agents/agent-card.tsx`）；状态 pill 惯例：`<span className="fa-tone-pill text-meta" style={{ "--tone": … }}>`（agent-card.tsx:90-98）。
> - `app/agents/task-board.tsx`（206 行）现状：`TaskBoardView`（顶层 gap-5 列）→ `BoardNode`（131 行，节点标题 + 内容）→ `DispatchCard`（90 行，Surface 单行卡）→ `StatePill`（39 行，STATE_TONE 五态映射）。cards 区当前 `flex flex-col gap-2` 单列。empty/manual 是单行 Surface + Link。
> - 测试影响面已核实：`tests/task-board.test.ts` 的 TB1-13 纯逻辑断言不触 DOM/class；SC1（无 `fetch(`）、SC2（含 `/chat/recent?id=`）是字符串契约——**改布局不撞，删深链才撞**。
> - 迁移三查已做（2026-07-08）：本分支链尾 v15 = main = 共享库 user_version 15；其它 worktree ≤14。**新迁移 = v16**。implementer 动手前用 `sqlite3 "$HOME/Library/Application Support/finance-agent/finance-agent.db" "PRAGMA user_version"` 复核一次，若 >15 立即停手报告。
> - `task.files` 现状：`subagent-runner.ts` 222-224 行拼进 prompt，**未落盘**；`recordDispatchStart` 调用在 119-127 行。`dispatch-store.ts`：`RecordDispatchStartInput`（12-24 行）、INSERT（34-48 行，9 列）、`DispatchRow`（199-213 行）、三处 SELECT（getDispatchById 109 / listDispatchesByRole 223 / listDispatchesForPeriod 316）均无 files。
> - `lib/domain/task-board.ts` `TaskBoardCard`（17-26 行）无 files 字段。
> - 两个批跑工具只能对话触发：`run_filing_precheck_batch`（产出增值税及附加/个税两卡）、`run_bank_recon_batch`（需用户先上传流水文件）。看板铁律：**零处理动作，只展示和深链**——批跑入口必须是 `<Link>` 深链到 `/chat/new?prompt=…` 预填对话，不是页内动作。
> - golden-schema 纪律：加列迁移必须同步 `tests/fixtures/golden-schema.json`（前刀教训，机械维护件）。
> - 测试命令：`source .venv/bin/activate && FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`；改过的测试文件须单跑复验退出码（假绿灯已修但纪律保留）；`npx tsc --noEmit` 源码零错误。

## 0. 目标与非目标

**目标**：看板从单列行式升级为富卡片网格（对标 financial-services 视频观感），补两处批跑深链入口，派发记录落盘 files 字段并在卡片展示输入文件名。

**非目标（本期不做，已知并接受）**：
- 卡片业务数字槽位（需子代理结构化摘要落盘，独立决策）。
- 申报三节点归组（等真实使用反馈）。
- 看板内锁定按钮/任何页内动作（铁律不动）。
- QUEUED 排队态（当前 fan-out 即运行，无排队概念）。
- 团队视图（角色卡）不动；抽屉不动。
- 历史派发行的 files 回填（新列旧行 NULL，显示为无文件即可）。

## 1. 成功标准

- [ ] 迁移 v16：`subagent_dispatches` 加 `files TEXT`（JSON 数组字符串，NULL 允许）；golden-schema 同步；旧行读出 files 为空数组——迁移测试覆盖。
- [ ] 数据链路：`SubagentTask.files` → `recordDispatchStart`（JSON.stringify 落盘，空数组/undefined 落 NULL）→ `DispatchRow.files: string[]`（三处 SELECT 均带，JSON 解析失败或 NULL 回退 `[]`，不抛错）——store 测试覆盖写读回环与坏 JSON 回退。
- [ ] `TaskBoardCard` 增 `fileNames: string[]`（domain 层从完整路径取 basename）——deriveTaskBoard 测试覆盖（含空数组）。
- [ ] 看板 UI：
  - cards 节点内改响应式网格 `repeat(auto-fill, minmax(240px, 1fr))`；
  - 卡片重构为块状：顶行 StatePill + 相对时间，主体 objectLabel（加重）+ summary（两行截断），blockedReason 用 `--tone-alarm` 红字 + `.fa-tone-edge` 左色条，locked 卡显示 🔒（沿用现状）；fileNames 非空时列出（最多 3 个 + "+N"，`text-meta` 弱化）；底部保留 `/chat/recent?id=` 深链（SC2 契约）；
  - 看板头部右侧新增主按钮样式 `<Link>`「批量复核申报前 →」→ `/chat/new?prompt=` 预填"把 {period} 申报前复核批量跑一遍（增值税及附加、个税各出一张复核卡）"；「银行对账」节点标题行新增次级 `<Link>`「批量对账 →」→ 预填"我要把本月各账户银行流水批量对一遍，稍后上传流水文件（每账户一个，可附账面记录）"；
  - 全部颜色经 token（不写死色值），亮/暗两主题下可读。
- [ ] 源码契约：task-board.tsx 仍无 `fetch(`、仍含 `/chat/recent?id=`（既有 SC1/SC2 不动）；新增 SC5 断言含两个批跑深链的 prompt 关键词（"申报前复核批量" 与 "批量对一遍"）。
- [ ] 全量测试绿 + 改动过的测试文件单跑 exit 0 + tsc 源码零错误 + **真机 preview 截图验证**（亮色网格布局 + 暗色一屏，由 orchestrator 在实施审查后执行，不算 implementer 职责）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | 追加 v16 `dispatch-files`：ALTER ADD `files TEXT`（带 subagent_dispatches 表存在性守卫，照 v15 写法） |
| `tests/fixtures/golden-schema.json` | 修改 | subagent_dispatches 增 files 列条目（机械维护） |
| `lib/db/dispatch-store.ts` | 修改 | Start 输入/INSERT 增 files；DispatchRow 增 `files: string[]`；三处 SELECT + 解析回退 |
| `lib/agent/subagent-runner.ts` | 修改 | recordDispatchStart 调用透传 task.files |
| `lib/domain/task-board.ts` | 修改 | TaskBoardCard 增 fileNames（basename 派生，纯函数内不 import node:path——手写 `p.split(/[\\/]/).pop()`，domain 层保持零 Node 依赖） |
| `app/agents/task-board.tsx` | 修改 | 网格布局 + 卡片重构 + 两个批跑深链 |
| `tests/subagent-dispatches.test.ts` | 修改 | v16 列存在、files 写读回环、NULL/坏 JSON 回退 |
| `tests/task-board.test.ts` | 修改 | fileNames 派生断言 + SC5 批跑深链契约 |

## 3. 实施步骤

1. **迁移 v16** `lib/db/migrations.ts`：条目 `{ version: 16, name: "dispatch-files", up }`——subagent_dispatches 表存在性守卫（照 v15），`addColumnIfMissing(db, "subagent_dispatches", "files", "TEXT")`。golden-schema.json 同步加列条目（**cid = 17**，locked_at 是 16；`notnull: 0, dflt_value: null`）。
2. **store** `lib/db/dispatch-store.ts`：
   - `RecordDispatchStartInput` 增 `files?: string[]`；INSERT 列表加 `files`，值 = `input.files && input.files.length ? JSON.stringify(input.files) : null`；
   - `DispatchRow` 增 `files: string[]`；三处 SELECT（getDispatchById/listDispatchesByRole/listDispatchesForPeriod）加 `files` 列，**getDispatchById 的内联行类型 cast 也要同步加 `files: string | null`**（N3）；行映射统一走一个小工具函数 `parseFiles(raw: string | null): string[]`（try/catch JSON.parse，非数组或异常回退 `[]`）。`listBlockedDispatches`/`BlockedDispatchRow` 明确**不加** files（attention 链路不消费，已核实无级联）。
3. **runner** `lib/agent/subagent-runner.ts`：119-127 行 `recordDispatchStart` 调用加 `files: task.files`。不动 prompt 拼接逻辑。
4. **domain** `lib/domain/task-board.ts`：`TaskBoardCard` 增 `fileNames: string[]`；映射处 `row.files.map(p => p.split(/[\\/]/).pop() ?? p)`。
5. **UI** `app/agents/task-board.tsx`（对照 §1 成功标准第 4 条逐项做；样式全部经 token/既有 utility，参照 agent-card.tsx 的 Surface/fa-tone-pill 写法；不引新依赖、不加 fetch）：
   - `BoardNode` cards 区：`className="grid gap-3"` + `style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}`（或 Tailwind 任意值类，与仓库现有写法一致者优先）；
   - `DispatchCard` 重构为块状卡（Surface shape="card"，内部 flex-col gap-2）；**blocked 卡的 Surface className 必须加 `relative`**——`.fa-tone-edge` 是 `position:absolute` 左色条，需要最近定位祖先，Surface 组件本身不带定位（B1）；blockedReason 红字用 `--tone-alarm`；fileNames 渲染 `fileNames.slice(0,3)` + 超出 `+N`，**为空数组时整个文件区不渲染**（filing-precheck 批跑无文件属正常态）；
   - 头部批跑主按钮：样式参照仓库现有主按钮（若无现成主按钮类，用 `.fa-toned` + `--tone-neutral` 加重变体，紧凑、右对齐）；`href` 用 `encodeURIComponent` 组装（period 来自 board.period）；银行对账节点的次级链接与节点标题同行右侧（与 empty 态"去派活→"同风格）；**节点识别只准用 `node.templateId === "bank-recon"`**——task-board.tsx 受 T4h 守卫约束不得出现角色中文名字面量，且模板中文名匹配本质脆弱（B3）。
6. **测试**：
   - `tests/subagent-dispatches.test.ts`：追加 v16 列存在；`recordDispatchStart({files:[a,b]})` → `getDispatchById().files` 回环；无 files → `[]`；手工 UPDATE 塞坏 JSON → 读出 `[]` 不抛；
   - `tests/task-board.test.ts`：**先给 `makeRow` 工具（44-75 行）的返回对象补必填新字段 `files: []`**——DispatchRow 类型收紧后所有既有用例经 tsc 必然报错，这是第一步（B2）；然后加 deriveTaskBoard 卡片 fileNames = basename 数组、无 files 时 `[]`；SC5 源码契约（两个批跑 prompt 关键词）；
   - 两文件单跑复验退出码。

## 4. 测试与验证方式

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/competent-thompson-d4dd37
source .venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/subagent-dispatches.test.ts   # 单跑复验
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/task-board.test.ts            # 单跑复验
npx tsc --noEmit
```

- 真机 preview 验证（亮/暗截图、网格换行、深链 href）由 orchestrator 在实施审查通过后执行，implementer 不起 dev server。
- 明确不需要：e2e、DOM 快照。

## 5. 风险与开放问题

- **files 含用户文件名（可能敏感）**：只落本地 SQLite、只在本机 UI 展示，不外发——与附件本身同一信任域，可接受；日志/遥测不得携带（本改动不触遥测）。
- **网格最小宽 240px 的取值**：卡片内容较少，240-280 之间由 implementer 按真机观感微调，不视为偏差（audit 写明最终值）。
- **批跑按钮的预填文案**：是给主对话 LLM 的指令语，措辞需能稳定命中对应批跑工具（description 已写分流）；若真机发现命中不稳，属 prompt 调优后续，不阻塞本刀。
- **主按钮样式若仓库无先例**：不引组件库，用 token 组合做加重变体即可，避免过度设计。
