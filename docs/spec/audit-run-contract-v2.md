# Audit: CR-R0 持久 Run 共享合同 v2

> Spec: `docs/spec/spec-run-contract-v2.md`  
> 日期：2026-07-22  
> 判定：**Frozen** — 下游 R1/Q1 可 import，不得复制 union

## 产出

| 文件 | 动作 |
|---|---|
| `lib/agent/run-contract.ts` | 新增：RunStatus、TerminationReason、状态转换、TaskContract / CompletionEvidence / Checkpoint 校验、settled 映射、CompletionGate 纯核对 |
| `lib/agent/runtime-events.ts` | 最小扩展：`run_state_changed`；`contractToLegacyEvents` → `[]`（不进 chat_agent_events） |
| `tests/run-contract.test.ts` | 新增纯函数测试 |
| `tests/all.test.ts` | 注册 |

## 验证

- `npx tsx tests/run-contract.test.ts` ✓
- `npx tsx tests/runtime-events.test.ts` ✓（AR2a S1–S5 outcome 三值未改）

## 明确未做（符合 Out of Scope）

- DB migration / `agent_runs` / `run_events`
- RunManager、Query Pipeline、SSE、UI
- 真实 CompletionGate 写入、validator

## 下游消费约定

- R1 / Q1 / R2 / P1 只从 `@/lib/agent/run-contract` 与 `runtime-events` import
- `run_settled.outcome` 仍为 `completed|aborted|error`
- migration 编号从 **v21** 起由 R1 申请（链尾现为 v20）
