# Audit: CR-Q1 通用交付物质量门与不可变交付

> Spec: `docs/spec/spec-deliverable-quality-gate.md`  
> 日期：2026-07-22  
> 判定：**Implemented** — 定向测试通过；Run 完成态仍归 R1 CompletionGate

## 产出

| 文件 | 动作 |
|---|---|
| `lib/deliverable/*` | 新增：types、scope、mime、hash、validators、store、immutable-copy、finalize、schema-v22 |
| `lib/agent/mcp-tools/finalize-deliverable.ts` | 重写：`FinalizeFile`、TaskContract 驱动、只提交 CompletionEvidence |
| `lib/chat/generated-files.ts` | working 不自动登记正式附件；仅 `delivered/` sync |
| `lib/agent/hooks/built-in.ts` | path-safety 拒写 `delivered/` |
| `lib/agent/mcp-tools/index.ts` | 透传 finalize options（runId/contract） |
| `lib/db/migrations.ts` | **v22** `deliverable_registry`（v21 已由 R1 占用） |
| `tests/deliverable-quality-gate.test.ts` | 新增 |
| `tests/mcp-tool-handlers.test.ts` / `generated-files.test.ts` / `all.test.ts` | 更新 |

## 验证

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/deliverable-quality-gate.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/mcp-tool-handlers.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/generated-files.test.ts
```

## 明确未做（符合 Out of Scope / MUST NOT）

- 不写 RunStore `completed`
- 不改 spreadsheet probe/recalc 实现（只 import consume）
- 不做合并报表财务勾稽（Q2）
- 不改 AR2a events / agent_runs 迁移（R1）
- 不接 Query Pipeline 模型接线（R1）；TaskContract 由宿主注入，缺省 finalize 拒绝

## Gaps / 接线

1. **TaskContract 注入**：`buildFinanceMcpServers(..., { finalize: { taskContract } })` 尚未由 Query Pipeline 调用；缺省 finalize → `missing_task_contract`。
2. **UI 状态组件**：提供 `AttachmentQualityState` 数据合同；CR-R2 负责接权威 Run 完成态展示。
3. **未 commit**：与 R1 共享 `migrations.ts` / `mcp-tools/index.ts` / `all.test.ts`，按指示留待合并协调。

## 合并注意

- migrations 链：`… → v21 (R1) → v22 (Q1)`。本分支 R1 v21 已在位。
- `golden-schema.json` 已含 deliverables / completion_evidence（与 v22 DDL 对齐；migration-discipline ✓）。
