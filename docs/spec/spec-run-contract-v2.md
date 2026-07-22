# Spec：持久 Run 共享合同 v2

> ID：CR-R0  
> 状态：**Frozen / Ready for Agent（下游可消费）**  
> 日期：2026-07-21  
> 冻结实现：`lib/agent/run-contract.ts` · 测试 `tests/run-contract.test.ts` · audit `audit-run-contract-v2.md`  
> 前置依赖：AR2a 已 ship  
> 下游：CR-R1、CR-Q1、CR-R2、CR-P1  
> 性质：共享合同与最小类型落地；不实现持久执行、UI 恢复或自动分段

## Problem Statement

复杂任务需要 `waiting_user/waiting_dependency/paused/completed` 等 Run 状态、TaskContract 和 CompletionEvidence，但现有 AR2a 只有实时事件合同，`run_settled` 的 outcome 已固定为 `completed|aborted|error`。若各下游功能自行定义状态与完成语义，会破坏已 ship 的 runtime event 类型和测试。

## Solution

冻结一套不泄漏 SDK 形状的 Run 共享合同，并显式映射到 AR2a。该合同由一个上游模块所有，下游只能 import。

## User Stories

1. 作为开发者，我希望等待、暂停和终态有唯一词表。
2. 作为前端，我希望能区分 Run 状态与 AR2a settled outcome。
3. 作为质量门，我希望提交完成证据而不是直接修改 Run 状态。
4. 作为恢复模块，我希望 checkpoint 和 termination reason 有稳定 schema。
5. 作为维护者，我希望既有 AR2a S1-S5 不被新状态机破坏。

## Implementation Decisions

### 1. Run Status

```ts
type RunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_dependency"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";
```

终态仅为 `completed/failed/canceled`。其他状态可恢复，不发 `run_settled`。

### 2. AR2a Mapping

`AgentRuntimeEvent.run_settled` 保持现有类型：

```ts
type SettledOutcome = "completed" | "aborted" | "error";
```

| RunStatus | outcome |
|---|---|
| completed | completed |
| canceled | aborted |
| failed | error |
| queued/running/waiting/paused | 不发 |

- 每个 Run 的持久日志中恰好一条 canonical settled。
- settled 后不再产生该 runId 的业务事件。
- 传输仍是 at-least-once，客户端按 eventId 去重。
- 不将 `failed/canceled` 加入 AR2a outcome union。

### 3. Termination Reason

```ts
type TerminationReason =
  | "user_stop"
  | "budget_exhausted"
  | "idle_timeout"
  | "hard_timeout"
  | "permission_denied"
  | "permission_expired"
  | "dependency_missing"
  | "validation_failed"
  | "model_auth"
  | "model_not_found"
  | "rate_limited"
  | "network_error"
  | "tool_error"
  | "process_crash"
  | "session_stale"
  | "sdk_error";
```

`client_disconnected` 不是 termination reason，只是订阅审计事件，不改变 Run 状态。

### 4. State Transitions

| From | Trigger | To |
|---|---|---|
| queued | runtime acquired | running |
| running | question created | waiting_user |
| running | dependency action required | waiting_dependency |
| waiting_user | answer accepted | running |
| waiting_dependency | capability ready | running |
| running | recoverable guard/quality condition | paused |
| paused | explicit resume | running |
| any non-terminal | explicit stop and quiesce complete | canceled |
| running | CompletionGate passed | completed |
| any non-terminal | unrecoverable error | failed |

状态变化发新增 `run_state_changed`；该事件与 `run_settled` 分工不同。是否把它加入现有 runtime event union 属于本包最小类型变更，但不在本包实现持久化和 UI reducer。

### 5. TaskContract

```ts
type SpreadsheetRequirement = {
  needsLegacyXlsRead: boolean;
  needsWrite: boolean;
  needsRecalc: boolean;
  needsRender: boolean;
  needsMacroPreservation: boolean;
};

type SpreadsheetAssertion =
  | { type: "cells_balance"; leftName: string; rightName: string; tolerance: number }
  | { type: "cash_reconcile"; cashFlowName: string; balanceSheetName: string; tolerance: number }
  | { type: "cell_equals"; definedName: string; expected: string | number }
  | { type: "cell_is_formula"; definedName: string };

type TaskContract = {
  version: 1;
  taskKind: "text" | "spreadsheet" | "financial_consolidation";
  spreadsheetRequirement?: SpreadsheetRequirement;
  requiredDeliverables: Array<{
    id: string;
    mime: string;
    count: number;
    qualityProfile: "generic" | "financial_consolidation";
  }>;
  expectationSnapshot: {
    company?: string;
    period?: string;
    assertions?: SpreadsheetAssertion[];
  };
};
```

- 合同由系统依据用户请求、附件和必要确认冻结。
- 模型、validator 和 finalize 不得降低或覆盖。
- 文件类型由系统 MIME/内容签名判断，不信任模型传入 kind。
- 信息不足时进入执行前确认，不能默认降级为 text/generic。

### 6. CompletionEvidence

```ts
type CompletionEvidence = {
  runId: string;
  contractDeliverableId: string;
  deliveredPath: string;
  deliveredSha256: string;
  mime: string;
  validatorId: string;
  qualityProfile: string;
  validationStatus: "passed";
  validatedAt: string;
  reportId: string;
};
```

- 质量模块提交 Evidence，不直接写 completed。
- RunStore 是完成状态唯一写入者。
- CompletionGate 必须核对全部 required deliverables、不可变文件哈希和模型回合结束证据。

### 7. Checkpoint Envelope

本包只冻结最小可扩展结构：

```ts
type RunCheckpoint = {
  version: 1;
  sessionId?: string;
  lastCompletedStage?: string;
  completedToolCallIds: string[];
  generatedFiles: Array<{ path: string; sha256: string; status: string }>;
  pendingAction?: { kind: string; id: string };
  capturedAt: string;
};
```

不在 checkpoint 中保存未确认权限或正在执行的子进程状态。

## File Ownership

允许：

- 新的共享 Run/Task/Completion type 模块。
- runtime event union 的最小 `run_state_changed` 扩展。
- 合同序列化、schema version 和纯状态转换测试。

禁止：

- DB migration、run_events、RunManager。
- Query route、SSE、前端状态。
- validator、权限、Spreadsheet Runtime。
- SDK 自动 resume/quiesce。

## Testing Decisions

- AR2a `run_settled` union 快照保持三值。
- RunStatus → outcome 映射全覆盖。
- waiting/paused 不产生 settled。
- settled 只允许从三种终态产生。
- TaskContract schema 拒绝空 required deliverable、未知 profile 和部分 expectation。
- CompletionEvidence 只接受 passed 和不可空 hash。
- checkpoint 禁止持久化 capability grant。
- 复用 runtime-events S1-S5，新增合同纯函数测试。

## Acceptance Criteria

1. 已 ship AR2a 测试无需改 outcome 期望即可通过。
2. Run 状态、termination reason、TaskContract、CompletionEvidence 有唯一导出位置。
3. 下游文档不再重复定义这些类型。
4. `client_disconnected` 不出现在 termination reason。
5. 纯状态转换和 schema 测试通过。
6. 本包无 DB、UI 或运行时行为变更。

## Out of Scope

- 持久事件和 replay。
- 状态恢复 UI。
- 自动续接和进程 quiesce。
- 实际 CompletionGate。
- Spreadsheet capability 探测。

## Further Notes

本包评审通过后状态改为 Ready for Agent；任何下游实现必须锁定本包版本，不得复制 union。

