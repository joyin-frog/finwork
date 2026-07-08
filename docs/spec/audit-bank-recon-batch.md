# 银行对账批跑审计报告（spec-bank-recon-batch v1.1）

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/agent/roles/task-templates.ts` | 修改——更新 bank-recon promptTemplate |
| `lib/agent/mcp-tools/bank-recon-batch.ts` | 新增——`createRunBankReconBatchTool` |
| `lib/agent/mcp-tools/index.ts` | 修改——注册 createRunBankReconBatchTool |
| `lib/agent/tools/registry.ts` | 修改——TOOL_REGISTRY 增 run_bank_recon_batch（safe） |
| `lib/agent/tools/renderers.ts` | 修改——增 run_bank_recon_batch 中文摘要 renderer |
| `tests/bank-recon-batch.test.ts` | 新增——15 项测试（5 校验路径 + fan-out + 聚合 + 注册链） |
| `tests/all.test.ts` | 修改——注册 bankReconBatchTestPromise |

## 各文件更改内容

### lib/agent/roles/task-templates.ts
bank-recon promptTemplate 从 4 行扩展为完整的多段文案：
- 【文件分工】：单派多账户两用，批跑收窄经补充上下文表达
- 【解析前置步骤】：先用 xlsx skill / run_python 解析成结构化行；direction 枚举口径（"in"/"out"）写死进模板；mapping 显式声明要求
- 【缺账面文件时的处理】：降级路径，阻塞项排最前，不硬造勾对
- 【输出要求】：保留逐笔列出/禁止静默跳过/尾差显式/一切只读等既有边界句

### lib/agent/mcp-tools/bank-recon-batch.ts
新文件，骨架照抄 filing-precheck-batch.ts，适配差异：
- schema：`statement_files: z.array(z.string()).min(1).max(8)`、`book_file: z.string().nullish()`、`period: z.string().nullish()`
- handler 内五条校验（不信任 schema，自行复查）：空列表 → isError / 超8 → isError / period格式 → isError / book_file冲突 → isError / 存在性检查（fileExistsFn，缺省fs.existsSync）→ 整批不派发列缺失路径
- fan-out：每个流水文件 = 一个 SubagentTask；businessObject = `path.basename(file, path.extname(file))`；extra 注明本卡负责的文件与账面文件路径或"未提供账面"；files = [流水文件, ...(book_file 若有)]
- runSubagentsParallel 保序假设加代码注释
- description 含"单账户"分流指引与"每个文件消耗一次派发额度"
- deps 注入：`run?: RunParallelFn`、`fileExists?: (p: string) => boolean`

### lib/agent/mcp-tools/index.ts
在申报前复核批跑行之后追加 `createRunBankReconBatchTool` 调用，及对应 import。

### lib/agent/tools/registry.ts
追加一行：`{ name: "mcp__finance_worker__run_bank_recon_batch", category: "finance", riskLevel: "safe" }`

### lib/agent/tools/renderers.ts
在 run_filing_precheck_batch renderer 之后追加：
```
run_bank_recon_batch: (i) => `银行对账批跑 ${files.length ?? "?"} 个账户`
```

### tests/bank-recon-batch.test.ts
15 项断言分 5 组：
- 模板属性与关键约束字样（roleId / mode / objectLabel / needsFiles / {{period}} / 逐笔列出 / 缺账面 / direction 口径句 / 只读）
- 角色白名单不含批跑工具（6 个角色逐一检查）
- description 内容断言（"单账户" + "派发额度"）
- 五条校验路径（T1-T5）+ fan-out（T6/T7）+ 聚合（T8/T9）
- TOOL_REGISTRY 登记且 riskLevel=safe

### tests/all.test.ts
末尾追加 bankReconBatchTestPromise。

## 与计划的偏差

无实质偏差。有一处措辞调整：

- spec 说 renderer 摘要示例为 `` `银行对账批跑 ${i?.statement_files?.length ?? "?"} 个账户` ``，实际实现用了 `Array.isArray` guard 再取 `.length`（与 renderers.ts 中其他 arrayLen 模式一致），功能等价，仅风格收敛。

## 测试结果

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# tests 11
# pass 11
# fail 0
```

bank-recon-batch 单测直接运行（tsx tests/bank-recon-batch.test.ts）：
```
bank-recon-batch: 模板属性与关键约束字样 ✓
bank-recon-batch: 角色白名单不含批跑工具 ✓
bank-recon-batch T-desc: description 分流指引 ✓
bank-recon-batch T1: 空列表校验 ✓
bank-recon-batch T2: 超限校验 ✓
bank-recon-batch T3: period 格式校验 ✓
bank-recon-batch T4: 文件不存在校验 ✓
bank-recon-batch T5: book_file 冲突校验 ✓
bank-recon-batch T6: fan-out 2 文件 + book_file ✓
bank-recon-batch T7: 1 文件无 book_file ✓
bank-recon-batch T8: 一成一败不置 isError ✓
bank-recon-batch T9: 双败置 isError ✓
bank-recon-batch: 工具路径全部通过 ✓
bank-recon-batch: TOOL_REGISTRY 登记 ✓
bank-recon-batch: all tests ✓
```

TypeScript 源码零错误（tests/ 基线错误为已知问题，与本任务无关）：
```
npx tsc --noEmit 2>&1 | grep -v "^tests/" | grep "error TS"
（无输出）
```

## 开放风险

与 spec §5 所列一致，无新增：

- **businessObject 同名碰撞**：不同目录同名文件（或跨月重复上传）产生相同 businessObject，靠 period 与派发时间区分，接受；子代理报告内含完整路径可追溯。
- **账面文件多账户归属**：筛错风险由模板阻塞项要求 + 人工锁定前复核兜底。
- **文件存在性检查时序**：本地单机、非安全边界，不做 TOCTOU 防护，接受。
- **8 个上限**：1-4 人团队账户数 2-5，宽裕上限，超限提示分批。

---

## 实施审查后修复（orchestrator 注，2026-07-08）

实施审查裁决 fix first，B1 及 N2-N4 已修（reviewer 明示 B1 修复后无需重审其余范围）：

- **B1**：模板【文件分工】段"若补充上下文指定了…"撞 tests/task-templates.test.ts T1a2 不变量（"补充上下文"字样仅允许出现在 expandTaskTemplate 注入段）——措辞改为"若指派说明中指定了…"（选项 A）。该失败曾被 tests/all.test.ts 的火忘式 IIFE 吞成 unhandledRejection 导致 npm test 假报全绿（本审计上文"11 pass 0 fail"即假绿），已单跑两测试文件（exit 0）+ 全量套件 + tsc 复验；测试聚合器的洞已立独立任务修复。
- **N2**：renderers.ts 死代码 `?? "?"` 删除。
- **N3**：补 task[1] instructions 断言与两个 label 断言（银行对账·<账户名>）。
- **N4**：补聚合文本"看板/锁定"提示断言。
