# 银行对账批跑 Spec（批跑第二刀）

> 版本 v1.1 / 2026-07-08
> 状态：已实施（计划批判 fix first→修正；实施审查 fix first→B1 模板措辞撞 T1a2 不变量已修（连带发现 all.test.ts 假绿灯洞，已立独立任务），reviewer 明示修后无需重审，2026-07-08；audit 见 audit-bank-recon-batch.md）
> 依赖：`spec-filing-precheck-batch.md`（批跑第一刀，本任务照其模式）、`spec-task-templates.md`（模板与对象化）、`spec-task-board.md`（看板）
> 架构事实（写给没读过代码库的人）：
> - 批跑第一刀参照实现：`lib/agent/mcp-tools/filing-precheck-batch.ts`——`createRunFilingPrecheckBatchTool(sdk, outputDir, traceId?, conversationId?, onSubagentEvent?, deps?)`，deps 注入 `{ run?: RunParallelFn; readProfile? }`，handler 流程 = 校验 → 组装 SubagentTask[]（roleId/instructions/label/taskTemplateId/businessObject/period）→ `runSubagentsParallel`（subagent-runner.ts:374，allSettled+信号量）→ 分段聚合 → `{content:[{type:"text",text}]}`，仅全败置 isError。注册链 = `mcp-tools/index.ts` + `tools/registry.ts`（safe）+ `tools/renderers.ts`（T6 守卫强制每个 finance 工具有中文摘要 renderer）。测试模式照 `tests/filing-precheck-batch.test.ts`（mock sdk 捕获 handler + fake runner 记录 calls，顶层 export testPromise，在 all.test.ts 注册）。
> - `reconcile_bank_statement`（`lib/agent/tools/finance/reconciliation.ts:11-98`，safe）：入参是**结构化行数组** `bankRows`/`bookRows`（`{date, amount, direction, description?, counterparty?}`，**direction 为 `z.enum(["in","out"])`——in=收入/进账、out=支出/出账**）+ `dateWindowDays?` + 文件名标注；确定性算法勾对（`lib/domain/reconciliation`），返回 content + structuredContent `{matched, bankOnly, bookOnly, needsReview, summary}`。**不吃文件路径**——工具描述明确要求调用方先用 run_python / xlsx skill 把文件解析成结构化行（无既有银行格式解析代码，全靠子代理现场解析）。
> - 附件机制：用户上传的文件落在会话专属目录（`attachment-guard.ts` 规范化），主对话 LLM 在用户消息里看到每个文件的**绝对路径**列表（`claude-adapter.ts:656-679`）。`runSubagent` 对 `task.files` 的处理（subagent-runner.ts:222-224）= 把路径列表拼到 instructions 末尾（"以下文件供参考：…"），不复制文件。
> - 资金专员（treasury-officer，registry.ts:95-111）：`tools: ["reconcile_bank_statement"]`、`skills: ["xlsx"]`；rolePrompt 边界：**一切操作只读**（付款/网银/代拟付款指令都不做）；对不上的流水逐笔列出（日期、金额、摘要、可能原因）禁止静默跳过；多账户分列再合计、尾差显式。
> - `bank-recon` 模板已存在（task-templates.ts:134-145，mode=subagent，needsFiles=true，objectLabel「银行账户」）——**看板「银行对账」节点已存在**，批跑派发带 `taskTemplateId:"bank-recon"` 即自动聚入该节点、进 pending→人工锁定流，无 UI 改动。
> - 测试命令：`source .venv/bin/activate && FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`；`npx tsc --noEmit` 源码须零错误（tests/ 基线错误除外）。

## 0. 目标与非目标

**目标**：主对话新增批跑工具 `run_bank_recon_batch(statement_files[], book_file?, period?)`——用户上传 N 个银行流水文件（每账户一个，可选一份账面记录文件）说"把这些流水都对一遍"，代码侧按流水文件 fan-out 资金专员子代理，每账户一张对象化派发卡（businessObject=文件名），全部进看板「银行对账」节点与人工锁定流。

**非目标（本期不做，已知并接受）**：
- 不做银行流水格式的确定性解析库（各行格式差异大，解析由子代理 + xlsx skill/run_python 现场完成，`reconcile_bank_statement` 勾对本身是确定性代码）。
- 不做文件夹扫描入口（附件机制已给出每个文件的绝对路径，够用；scan_slip_folder 模式留给真实需求出现时）。
- 不建银行账户主数据——账户身份 = 流水文件名（子代理在报告中声明识别口径）。
- 不做账面数据的系统内基准（账面来自用户提供的文件；无账面文件时降级为"流水体检 + 缺账面阻塞项"，不硬造勾对）。
- 不改看板/菜单/抽屉 UI（对象化机制自动生效）。
- 不做定时/自动锁定（同第一刀）。

## 1. 成功标准

- [ ] `bank-recon` 模板 promptTemplate 更新为单账户批跑两用文案（见 §3 步骤 1），含：解析前置步骤指示（先把流水/账面解析成 `{date, amount, direction}` 结构化行再调 reconcile_bank_statement，方向口径须在报告中声明）、缺账面文件时的降级路径（流水概况 + 「缺账面记录，本期无法勾对」阻塞项排最前，不硬造对账结论）、保留"对不上逐笔列出/禁止静默跳过/尾差显式"边界——单测断言模板含关键约束字样。
- [ ] 新工具 `run_bank_recon_batch`：`statement_files` 必填（1-8 个绝对路径）、`book_file` 可选、`period` 可选缺省 `currentYearMonth()`；**全部五条校验（空列表 / 超 8 个 / period 非法 / 任一文件不存在 / book_file 重复出现在 statement_files）在 handler 内实现**（zod schema 仍写 min(1).max(8) 作为第一道防线，但 handler 不信任 schema、自行复查——单测直接调 handler 即可逐条覆盖，无双轨歧义），各返回 isError 文本且不派发。
- [ ] fan-out 正确：每个流水文件一个 SubagentTask——roleId=treasury-officer、taskTemplateId="bank-recon"、businessObject=文件名（去目录去扩展名）、period、`files` = [该流水文件] + （book_file 若有）、instructions = `expandTaskTemplate("bank-recon", period, extra)`（extra 注明本卡只负责这一个账户文件、账面文件路径或"未提供账面"）——fake runner 断言入参。
- [ ] 聚合返回 CallToolResult 形状，按账户分段列状态与摘要，仅全败置 isError，末尾提示看板与锁定；工具 description 写明分流（多账户批量用本工具、单账户用 spawn_subagent + bank-recon 模板）与"每个文件消耗一次派发额度"。
- [ ] 注册链完整：TOOL_REGISTRY（safe）、renderers 中文摘要、不进任何角色 tools 白名单（防递归）——单测断言。
- [ ] 全量测试跑绿 + `npx tsc --noEmit` 源码零错误。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/roles/task-templates.ts` | 修改 | 更新 bank-recon promptTemplate（单账户批跑两用 + 解析指示 + 缺账面降级） |
| `lib/agent/mcp-tools/bank-recon-batch.ts` | 新增 | `createRunBankReconBatchTool(sdk, outputDir, traceId?, conversationId?, onSubagentEvent?, deps?)`，deps 注入 `{ run?: RunParallelFn; fileExists?: (p: string) => boolean }` |
| `lib/agent/mcp-tools/index.ts` | 修改 | 注册新工具（接线照 filing-precheck-batch） |
| `lib/agent/tools/registry.ts` | 修改 | TOOL_REGISTRY 增 run_bank_recon_batch（safe，finance，照邻近条目） |
| `lib/agent/tools/renderers.ts` | 修改 | 增 run_bank_recon_batch 中文摘要 renderer |
| `tests/bank-recon-batch.test.ts` | 新增 | 校验路径 + fan-out 入参 + 聚合 isError + 注册链断言（组织照 tests/filing-precheck-batch.test.ts） |
| `tests/all.test.ts` | 修改 | 注册新测试文件 |

## 3. 实施步骤

1. **模板更新** `lib/agent/roles/task-templates.ts` 的 `bank-recon.promptTemplate`，要点（写前逐条对照 treasury-officer rolePrompt 边界；**文案必须是面向子代理的自然语言，不得出现 "extra"/"批跑" 等系统术语**）：
   - 期间 `{{period}}`；文件分工用中性措辞：**"若补充上下文指定了本次负责的账户流水文件，只处理该文件；否则处理用户提供的全部流水文件（多账户时按账户分列再合计，明细之和须等于合计）"**——单派多账户的既有引导保留，批跑收窄经补充上下文表达，两用自洽；
   - 解析前置：先用 xlsx skill / run_python 把流水文件解析成 `{date, amount, direction, description}` 结构化行，**direction 只能取 "in"（收入/进账）或 "out"（支出/出账）**（reconcile_bank_statement 的 enum 口径，写死进模板）；银行"收/付"与账面"借/贷"到 in/out 的映射由子代理在报告中显式声明；再解析账面文件中属于本账户的记录（按 sheet 名/账户列筛选，找不到本账户数据时列为阻塞项）；两边就绪后调 reconcile_bank_statement；
   - 缺账面文件：不硬造勾对——输出流水概况（笔数、收付合计、期间覆盖）+ 阻塞项「缺账面记录，本期无法勾对」排最前；
   - 保留既有边界句：对不上的流水逐笔列出（日期、金额、摘要、可能原因）、禁止静默跳过或模糊汇总、合计与尾差显式说明；一切只读。
2. **批跑工具** `lib/agent/mcp-tools/bank-recon-batch.ts`（骨架照抄 filing-precheck-batch.ts）：
   - schema：`{ statement_files: z.array(z.string()).min(1).max(8), book_file: z.string().nullish(), period: z.string().nullish() }`；
   - 校验全部在 handler 内自行复查（不信任 schema，见成功标准），顺序：statement_files 非空且 ≤8 → period 格式（缺省 currentYearMonth()）→ book_file 与 statement_files 去重冲突 → 逐个 `deps.fileExists`（缺省 `fs.existsSync`）检查所有路径（含 book_file），任一不存在 → isError 列出缺失路径、整批不派发（让主对话纠正，不派半批）；
   - fan-out：每个流水文件组装 task——`businessObject` = `path.basename(file, path.extname(file))`；`extra` = `本卡只负责账户流水文件：${file}${book_file ? `；账面记录文件：${book_file}（只取属于本账户的记录）` : "；用户未提供账面记录文件，按缺账面降级路径执行"}`；`files` = `[file, ...(book_file ? [book_file] : [])]`；label = `银行对账·${businessObject}`；
   - `runSubagentsParallel` 并行——**结果与任务按入参顺序一一对应**（内部 Promise.allSettled 保序，filing-precheck-batch 已依赖此假设，代码注释记录）；聚合与 isError 语义照第一刀；description 写分流与额度提示。
3. **注册** index.ts / registry.ts / renderers.ts 照第一刀三处接线（renderer 摘要如 `(i) => \`银行对账批跑 ${i?.statement_files?.length ?? "?"} 个账户\``，具体照邻近条目风格）。
4. **测试** `tests/bank-recon-batch.test.ts`（组织照 filing-precheck-batch.test.ts）：
   - 校验五条失败路径全部直接调 handler 覆盖（空列表、9 个超限、period 非法、文件不存在、book_file 冲突——handler 内自行复查，见成功标准，无 zod 依赖歧义）；
   - description 内容断言：含"单账户"分流指引与"派发额度"字样（description 是 LLM 选工具的依据，漏写是静默故障）；
   - fan-out：2 文件 + book_file → 2 个 task，断言每个 task 的 roleId/taskTemplateId/businessObject/period/files/instructions 含 extra 关键句；1 文件无 book_file → files 只含流水、extra 含"未提供账面"；
   - 聚合：双成功文本含两账户名；一成一败不置 isError；双败置 isError；
   - 注册链：TOOL_REGISTRY 存在且 safe；各角色 resolveRoleAllowedTools 不含；模板关键约束字样断言（"逐笔列出"、"缺账面"、direction 口径句）。
5. `tests/all.test.ts` 注册。

## 4. 测试与验证方式

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/competent-thompson-d4dd37
source .venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npx tsc --noEmit
```

- 明确不需要：e2e、真实 LLM 派发、真实银行文件解析测试（解析是子代理运行时行为，非本任务代码）；UI 零改动零测试。

## 5. 风险与开放问题

- **businessObject 同名碰撞（已知限制）**：不同目录的同名流水文件、或跨月重复上传同名文件，会产生 businessObject 相同的卡，区分靠 period 与派发时间——1-4 人团队文件命名习惯下概率低，接受；子代理报告内含完整路径可追溯。
- **账面文件的账户归属**：一份账面文件多账户混录时，子代理按 sheet/账户列筛选可能筛错——模板已要求"找不到本账户数据列阻塞项"，筛选错误风险由人工锁定前的复核兜底（卡片内容可追溯）。
- **文件存在性检查的时序**：附件在会话目录内持久，派发瞬间存在即可；不做防 TOCTOU（本地单机、非安全边界）。
- **8 个上限**：1-4 人团队账户数 2-5，8 为宽裕上限防 LLM 误传大数组；超限提示分批。
- **主对话工具选择**：statement_files 由主对话 LLM 从附件路径列表填入——填错路径被存在性检查拦截；漏填某账户由用户在对话中追加（聚合文本列出了本批覆盖的文件名）。
