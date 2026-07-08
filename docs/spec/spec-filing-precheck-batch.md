# 申报前复核批跑 Spec（功能 4 首刀）

> 版本 v1.1 / 2026-07-07
> 状态：已实施（计划批判 fix first→修正；实施审查裁决 ship，2026-07-07；audit 见 audit-filing-precheck-batch.md；真机确认看板 7 节点渲染正常）
> 依赖：`spec-task-templates.md`（任务模板 + 派发对象化，迁移已重编号 v13）、`spec-task-board.md`（本月任务看板）
> 架构事实（写给没读过代码库的人）：
> - 任务模板在 `lib/agent/roles/task-templates.ts`：`TaskTemplate { id, roleId, name, description, mode, skillName?, needsFiles?, objectLabel?, promptTemplate? }`，现有 5 条；`expandTaskTemplate(id, period, extra?)` 展开（校验 `^\d{4}-\d{2}$`），`currentYearMonth(d = new Date())` 已导出。模板数据被三处消费：派活菜单（`agent-card.tsx:134` `getTemplatesForRole`）、看板（`route.ts:139` `deriveTaskBoard(TASK_TEMPLATES,…)`，subagent 型模板自动成为带卡片的节点）、spawn 工具 cheatsheet（`mcp-tools/subagent.ts` 按角色列模板）。**新增 subagent 型模板三处自动生效，无需改 UI**。
> - 子代理经 `runSubagent`（`lib/agent/subagent-runner.ts`）执行：每次调用生成独立 outputDir（`subagents/<label>_<Date.now()>/`），落 `subagent_dispatches` 行（含 taskTemplateId/businessObject/period），是 async 函数、可 Promise.all 并行（代码库尚无并行先例，但 spawn_subagent 工具文档明确 SDK 层已支持一次响应多次调用并行）。
> - **子代理不注入公司画像**（`buildSubagentSystemPrompt` 只拼共享基座 + rolePrompt）——这是税务 filing-precheck 技能只能主对话执行的原因（registry.ts:79 注释）。公司画像：`lib/profile/file-store.ts:18` `readCompanyProfile()`，含 `taxpayerType?: "小规模" | "一般纳税人"`。
> - 主对话 MCP 工具注册在 `lib/agent/mcp-tools/index.ts` `createFinanceMcpServer`（参照最近新增的 `createEmitChecklistTool`，index.ts:48）；riskLevel 在 `lib/agent/tools/registry.ts` 的 `TOOL_REGISTRY` 声明，只读类工具定 `safe`（进 ALLOWED_TOOLS，无确认门）。角色白名单 `role.tools` 不含的工具子代理不可调。
> - **MCP 工具 handler 必须返回 CallToolResult 形状 `{content:[{type:"text",text}]}`**，裸字符串会被 SDK 判 isError（历史 bug，回归锁 tests/subagent-result-shape.test.ts）。
> - 税务专员（tax-officer）工具：`tax_calculator, query_payroll_status, query_invoice_ledger`。`query_payroll_status` 返回 `{ drafts[], confirmed[] }`，每条 `{ employeeName, netPay, taxCurrent }`（实发/当月个税，元）——**能区分期间是否已确认，但无应发（gross）字段**。`query_invoice_ledger(year, month)` 返回 `{ total, directionIn: { count, taxAmountCentsSum }, uncertifiedCount, directionUnknownCount }`——**口径警告：只有 total 与 directionIn 按 invoice_date 归月；`uncertifiedCount` 与 `directionUnknownCount` 是全库无期间过滤的计数**（finance-store.ts:539-544 无 invoice_date 条件），销项 = total − directionIn.count（无独立销项字段）。工具入参是 `year:int, month:int`，模板须指示子代理把 "YYYY-MM" 拆成两个整数传参。
> - `runSubagentsParallel`（subagent-runner.ts:374）已存在：内部 Promise.allSettled + 信号量限并发，批跑直接复用，不要自造 Promise.all。
> - 税务专员 rolePrompt 边界（registry.ts:85-92，模板文本不得违反）：不提交申报；不替用户拍板；**个税一致性核对只用已确认期间的汇总数、不读工资明细**；政策结论带来源与时效，查不到写「未核实当年政策」。
> - 派发完成 → review_status='pending' → 人在角色抽屉锁定（既有机制，本任务不动）。
> - 测试：node:test，聚合 `tests/all.test.ts`；命令 `source .venv/bin/activate && FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`。`tests/task-templates.test.ts` 可能断言模板总数（implementer 核实并同步）。

## 0. 目标与非目标

**目标**：主对话新增确定性批跑工具 `run_filing_precheck_batch(period?)`——代码侧读取公司画像（纳税人资格）注入上下文，并行派发 2 个税务专员子代理（「增值税及附加复核」「个税申报一致性复核」），各自落一张对象化派发卡（含 taskTemplateId/business_object/period），自动进看板与"待锁定"流。用户在报税期说一句"把本月申报前复核跑一遍"，得到两张按税种分列、全部需人拍板锁定的复核卡。

**非目标（本期不做，已知并接受）**：
- 不做定时/自动触发（信任级别未到，手动触发建立信任）。
- 不做自动锁定——两张卡 100% 走既有 pending→人工锁定流。
- 不动既有 filing-precheck main-skill 模板（主对话综合复核仍是更深入的入口，两者并存）。
- 不做银行对账批跑（需按账户传文件，机制不同，第二刀）。
- 不做批跑通用框架（BATCH_REGISTRY 等）——一个具体工具，第二个批跑出现时再抽象。
- 不改看板/派活菜单/抽屉任何 UI（数据驱动自动生效）。
- 企业所得税预缴、印花税等其他税种不进首刀（数据面不足，宁缺毋滥）。

## 1. 成功标准

- [ ] `TASK_TEMPLATES` 新增 2 条 subagent 型模板 `vat-filing-precheck`（objectLabel「增值税及附加」）、`iit-filing-precheck`（objectLabel「个税」），紧排在 `filing-precheck` 之后；模板文本含 `{{period}}` 占位、遵守税务专员全部边界条款（个税模板明写"只用已确认期间汇总数，期间未确认时列为阻塞项而非去读草稿明细"；政策口径写"需核实当年政策"）——单测覆盖模板存在性、归属、占位符。
- [ ] 新工具 `run_filing_precheck_batch`：`period` 可选（缺省 `currentYearMonth()`），非法格式返回 isError 文本且不派发；合法时读 `readCompanyProfile()` 把纳税人资格（未配置则明说"资格未知，请先判断适用性，无法判断列为无法核验"）拼入 extra 上下文，经**既有 `runSubagentsParallel`** 并行跑 2 个子代理任务（roleId=tax-officer，带 taskTemplateId/businessObject/period）——通过注入 runner 的单测覆盖：默认期间、显式期间、非法期间、双成功、一成一败、双失败六条路径。
- [ ] 聚合返回 CallToolResult 形状：按税种分段列状态与内容摘要；**仅双双失败时置 isError**（部分成功要让主对话能转述已完成的一半）；结果文本提醒"两张复核卡已进看板，确认无误后在角色抽屉锁定"。
- [ ] `TOOL_REGISTRY` 登记为 safe（只读复核 + 派发，无确认门）；工具不进任何角色的 `tools` 白名单（子代理不可递归批跑）——单测断言注册存在 + 不在各角色解析后的工具列表中。
- [ ] 派发行落库正确：两行的 task_template_id/business_object/period 各自对应——通过注入 runner 捕获入参断言（不依赖真实 LLM）。
- [ ] 全量测试跑绿 + `npx tsc --noEmit` 干净（非测试文件）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/roles/task-templates.ts` | 修改 | 追加 2 条批跑子模板（插在 filing-precheck 之后） |
| `lib/agent/mcp-tools/filing-precheck-batch.ts` | 新增 | `createRunFilingPrecheckBatchTool(sdk, outputDir, traceId?, conversationId?, onSubagentEvent?, deps?)`，deps 可注入 `{ run?: typeof runSubagent, readProfile?: typeof readCompanyProfile }` |
| `lib/agent/mcp-tools/index.ts` | 修改 | 注册新工具（照 createEmitChecklistTool 的接线，透传 onSubagentEvent） |
| `lib/agent/tools/registry.ts` | 修改 | TOOL_REGISTRY 增 run_filing_precheck_batch（safe，finance 类目，描述性字段照邻近条目） |
| `lib/agent/tools/renderers.ts` | 修改 | 增 run_filing_precheck_batch 的中文摘要 renderer（tests/tool-registry.test.ts T6 强制要求每个 finance 工具有 renderer，照 spawn_subagent/emit_checklist 写法） |
| `tests/filing-precheck-batch.test.ts` | 新增 | 工具六条路径 + 模板存在性 + 角色白名单不含断言 |
| `tests/task-templates.test.ts` | 修改（可能零改动） | 已核实无总数断言、T2 是泛型遍历 subagent 模板（自动覆盖新模板）；仅当既有断言因新模板失效时才动 |
| `tests/all.test.ts` | 修改 | 注册新测试文件 |

## 3. 实施步骤

1. **模板** `lib/agent/roles/task-templates.ts`，插在 filing-precheck 条目之后：
   - `vat-filing-precheck`（tax-officer，「增值税及附加复核」，objectLabel「增值税及附加」）promptTemplate 要点：期间 `{{period}}`，**并显式指示"调用 query_invoice_ledger 时把期间拆为 year、month 两个整数"**；取本期台账概况（本期总张数、本期进项张数与税额），销项张数按 total−进项推算并显式说明口径；**必须向子代理声明：uncertifiedCount / directionUnknownCount 是全库累计口径、非仅本期，输出中必须标注"全库累计（含历史）"字样，禁止表述为"本期未认证"**；输出检查清单——①全库未认证进项提醒（张数与税额影响抵扣，标注口径）、②方向未知发票需人工归类清单（标注口径）、③台账为空/数据明显不全时列"无法核验"并说明缺什么；附加税按增值税联动一句带过；一切税率与申报期限结论标注「需核实当年政策」；不替用户判断申报数据对错，只给核对项与依据。
   - `iit-filing-precheck`（tax-officer，「个税申报一致性复核」，objectLabel「个税」）promptTemplate 要点：期间 `{{period}}`；用 query_payroll_status 查该期间——若 confirmed 为空或 drafts 非空，把"薪资期间未确认/存在草稿"列为**阻塞项排最前**（对齐上游未锁定规则），不得转而读取草稿明细；已确认时汇总人数、实发合计、当月个税合计，产出"与扣缴端申报表核对"的对照清单（申报人数、税额合计两项）；明写只用已确认汇总数、不读工资明细；结论不拍板，只列核对项。
   - 两模板 mode="subagent"，description 一句话（进派活菜单与 cheatsheet）。
2. **批跑工具** `lib/agent/mcp-tools/filing-precheck-batch.ts`（新文件，参照 `subagent.ts` 的 createSpawnSubagentTool 结构）：
   - 签名：`createRunFilingPrecheckBatchTool(sdk, outputDir, traceId?, conversationId?, onSubagentEvent?, deps?)`；`deps.run` 缺省动态 `import("@/lib/agent/subagent-runner")`（照 spawn 工具的动态 import 写法），`deps.readProfile` 缺省 `readCompanyProfile`。
   - schema：`{ period: z.string().nullish() }`；handler：period 缺省 `currentYearMonth()`；正则校验失败 → 返回 isError 文本（不派发）。
   - 工具 description 写明分流：**"需要把申报前复核整套跑一遍（增值税+个税各一卡）用本工具；单税种复核用 spawn_subagent + 对应模板"**，并注明"消耗两次派发额度"。
   - 上下文注入：`readProfile()` 取 `taxpayerType`——有值拼 `补充上下文：本公司纳税人资格：${taxpayerType}（增值税${taxpayerType === "一般纳税人" ? "月报" : "季报"}口径，申报期限以当年日历为准）`；无值或空对象拼"纳税人资格未配置：请先形式判断本期适用性，无法判断的项列为无法核验"（`readCompanyProfile` 内部已兜异常、失败返回 `{}`，无需额外 try/catch）。
   - fan-out：对 `["vat-filing-precheck", "iit-filing-precheck"]` 各 `expandTaskTemplate(id, period, extra)` 组装 task（`{ roleId: "tax-officer", instructions, label: 模板名, taskTemplateId: id, businessObject: objectLabel, period }`），**复用既有 `runSubagentsParallel`（subagent-runner.ts:374，Promise.allSettled + 信号量，勿自造 Promise.all）**；deps.run 注入点相应改为可注入 `runSubagentsParallel` 同签名函数。
   - 聚合：每税种一段（名称、成功/失败、耗时、content）；末尾提示看板与锁定；返回 `{ content: [{ type: "text", text }] }`，仅两者皆败时加 `isError: true`。
3. **注册** `lib/agent/mcp-tools/index.ts`：tools 数组加 `createRunFilingPrecheckBatchTool(...)`，参数接线与 createSpawnSubagentTool 一致（outputDir/traceId/conversationId/onSubagentEvent）。
4. **TOOL_REGISTRY** `lib/agent/tools/registry.ts`：增条目（全名前缀照 spawn_subagent/emit_checklist 的既有命名惯例），riskLevel safe；确认它进 ALLOWED_TOOLS（safe 不被排除）。
5. **测试** `tests/filing-precheck-batch.test.ts`：注入 fake run（记录入参、按脚本返回 success/fail）与 fake readProfile；六条路径断言（含入参 taskTemplateId/businessObject/period 正确、双败才 isError、非法期间不调 run）；模板存在性与 `resolveRoleAllowedTools("tax-officer")` 等各角色列表不含批跑工具全名。`tests/task-templates.test.ts` 同步总数断言（若有）。`tests/all.test.ts` 注册。

## 4. 测试与验证方式

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/competent-thompson-d4dd37
source .venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npx tsc --noEmit
```

- 明确不需要：e2e；真实 LLM 派发（fan-out 正确性全走注入 runner 断言）；看板/菜单 UI 测试（数据驱动，spec-task-board 既有测试已覆盖派生逻辑）。

## 5. 风险与开放问题

- **两个子模板会出现在派活菜单**（getTemplatesForRole 不区分）：这是接受的行为——用户也可以单税种手动派发；菜单从 1 项变 3 项在可读范围内。若嫌多是后续 UI 取舍，不在本 spec。
- **看板变 7 节点**：两新模板自动成为独立节点（cards 路径），与 filing-precheck manual 节点并存。首刀接受；若用户反馈"申报前复核出现三行很乱"，再做 boardGroup 归组（已知的后续选项，本期不做）。
- **query_invoice_ledger 数据面粗**（无独立销项、按 invoice_date 归月）：模板要求子代理显式声明口径与推算方式，数据不足列无法核验——复核价值主要在"未认证进项/方向未知/上游未锁定"三类可操作提醒，不承诺申报数勾稽。
- **并行错误处理**：复用 `runSubagentsParallel`（内部 Promise.allSettled + 信号量）即天然满足"一个失败不吞另一个"；实施审查确认没有自造并行轮子即可。
- **额度消耗**：一次批跑 = 2 个子代理会话。工具描述中写明"消耗两次派发额度"，让主对话在转述时可提示用户。
