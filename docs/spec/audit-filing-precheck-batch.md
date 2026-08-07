# Audit: filing-precheck-batch

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `lib/agent/roles/task-templates.ts` | 修改 | 在 filing-precheck 之后追加 `vat-filing-precheck` 与 `iit-filing-precheck` 两条 subagent 型模板 |
| `lib/agent/mcp-tools/filing-precheck-batch.ts` | 新增 | `createRunFilingPrecheckBatchTool` 工具实现，含 deps 注入接口 |
| `lib/agent/mcp-tools/index.ts` | 修改 | import 并注册 `createRunFilingPrecheckBatchTool`，透传 outputDir/traceId/conversationId/onSubagentEvent |
| `lib/agent/tools/registry.ts` | 修改 | TOOL_REGISTRY 增 `run_filing_precheck_batch`（category: finance, riskLevel: safe） |
| `lib/agent/tools/renderers.ts` | 修改 | summaries 增 `run_filing_precheck_batch` 中文摘要 renderer |
| `tests/filing-precheck-batch.test.ts` | 新增 | 覆盖模板存在性/角色白名单/工具六条路径/TOOL_REGISTRY 登记 |
| `tests/all.test.ts` | 修改 | 末尾追加注册 `filingPrecheckBatchTestPromise` |

---

## 各文件改动内容

### task-templates.ts
在 `filing-precheck`（index 2）之后插入两条模板：
- `vat-filing-precheck`：mode=subagent，roleId=tax-officer，objectLabel="增值税及附加"；promptTemplate 含 `{{period}}`，声明全库累计口径（禁止写"本期未认证"），指示把期间拆为 year/month 整数传 query_invoice_ledger，输出三级检查清单，政策结论标注「需核实当年政策」。
- `iit-filing-precheck`：mode=subagent，roleId=tax-officer，objectLabel="个税"；promptTemplate 含 `{{period}}`，把"期间未确认/存在草稿"列为阻塞项排最前，禁止读草稿明细，已确认时汇总人数/实发/个税合计，产出两项核对清单。

### filing-precheck-batch.ts（新文件）
- 签名：`createRunFilingPrecheckBatchTool(sdk, outputDir, traceId?, conversationId?, onSubagentEvent?, deps?)`
- `deps.run` 注入 `runSubagentsParallel` 同签名函数；`deps.readProfile` 注入 `() => Promise<CompanyProfile>`；两者均缺省真实实现（动态 import / 静态 import）。
- period 缺省 `currentYearMonth()`；正则 `/^\d{4}-\d{2}$/` 失败 → isError，不派发。
- 读画像后构建 `extra` 字符串（有 taxpayerType 则含月报/季报口径，无则"资格未配置"），传入 `expandTaskTemplate`（由其加"补充上下文："前缀）。
- 调用 `runSubagentsParallel`（既有，Promise.allSettled + 信号量）并行跑两任务。
- 聚合：仅双双失败时 `isError: true`；末尾附看板锁定提示。

### index.ts
追加一行 import 与一行工具注册（紧接 emit_checklist 之后）。

### registry.ts
追加一条：`{ name: "run_filing_precheck_batch", category: "finance", riskLevel: "safe" }`。未加入任何角色的 tools 白名单。

### renderers.ts
在 finalize_deliverable 之前追加 `run_filing_precheck_batch` renderer，格式：`批跑申报前复核（增值税+个税）${period}` 或无期间时的缩略版。

### filing-precheck-batch.test.ts（新文件）
覆盖：
- 模板存在性（存在、roleId、mode、objectLabel、{{period}} 占位符、VAT 全库累计声明、IIT 阻塞项+禁止读草稿、排序紧接 filing-precheck 之后）
- 角色白名单（6 个角色均不含批跑工具全名）
- 工具 T1 非法 period → isError，不调 run
- 工具 T2 默认 period → 使用当前年月
- 工具 T3 显式 period → 校验 roleId/taskTemplateId/businessObject/period 全部正确
- 工具 T4 双成功 → 无 isError，含看板提示
- 工具 T5 一成一败 → 无 isError（部分成功）
- 工具 T6 双失败 → isError
- TOOL_REGISTRY 存在性 + riskLevel=safe

---

## 与计划的偏差

无实质偏差。以下两处是实现细节判断：

1. **`extra` 字符串不含 "补充上下文：" 前缀**：spec §3 写 `有值拼 补充上下文：本公司纳税人资格：...`，但 `expandTaskTemplate` 内部自动在 extra 前加 "补充上下文："，若 extra 含前缀会重复。实际传入：`本公司纳税人资格：${taxpayerType}...`，展开后结果与 spec 描述的最终内容一致。

2. **`readCompanyProfile` 静态 import**：spec 说 "缺省 `readCompanyProfile`"，未限定 import 方式。选用静态 import 而非动态 import，理由是该模块无副作用、无 LLM 依赖，静态 import 类型安全性更好。

---

## 测试命令与结果

```
source /Users/gyro/codex/finance-agent-public/workers/.venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```

结果：全量测试通过（11 suites，11 pass，0 fail）。新增测试全部通过，含六条路径。

```
npx tsc --noEmit
```

结果：lib/agent/mcp-tools/filing-precheck-batch.ts、index.ts、roles/task-templates.ts、tools/registry.ts、tools/renderers.ts 零错误。test/ 和 e2e/ 下有若干 TS5097（.ts 扩展名）与 TS2775 错误均为预存在的问题，与本 PR 无关。

---

## 开放风险

1. **task-templates.test.ts T3 路径通过 API key 早返回**：T3 用的是真实 runSubagent，只因 API key 缺失才失败而非校验错误；新模板走的是 filing-precheck-batch 独立测试，不经 T3。可以接受。

2. **uncertifiedCount/directionUnknownCount 口径警告只在模板文本中**：数据库层面无法强制，依赖 LLM 遵守模板指令。该风险已在 spec §5 记录，本期接受。

3. **看板新增两节点**：vat-filing-precheck 和 iit-filing-precheck 自动成为看板节点（数据驱动），与 spec §5 已知风险一致，不额外处理。
