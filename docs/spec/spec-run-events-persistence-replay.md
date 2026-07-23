# Spec：Run 事件持久化与重放

> ID：CR-R1  
> 对应 ROADMAP：AR2b  
> 状态：**已ship** · `audit-run-events-persistence-replay.md`（migration v21）  
> 日期：2026-07-21  
> 前置依赖：AR2a、CR-M1、CR-R0  
> 下游：CR-R2、CR-P1

## Problem Statement

AR2a 已统一实时事件 envelope，但 eventId 仍是内存 per-emitter 计数，`run_settled` 不落库，SSE 断开后无法重放；trace 只在回合结束写一行，无法区分正在执行、等待、系统错误和用户停止。当前 UI 仍依赖旧 `done/incomplete/error` 帧。

## Solution

新增持久 `agent_runs` 与 `run_events` 账本，服务端在事件发射时记录 checkpoint/终态事件，提供按 eventId 重放 API。高频文本 delta 继续只走实时通道，避免 SQLite 和网络 O(n²)。同时接入 CR-M1 的真实模型解析结果。

## User Stories

1. 作为用户，我希望断线后能看到已经完成的步骤。
2. 作为前端，我希望通过 cursor 增量重放，不必重新加载全部对话。
3. 作为排障人员，我希望每个 Run 从创建开始就有状态和真实模型记录。
4. 作为成本管理员，我希望中断回合也保留累计 usage。
5. 作为后续恢复模块，我希望有稳定 checkpoint 和事件日志可消费。

## Implementation Decisions

### 1. Tables

`agent_runs` 至少包含：

```text
run_id, trace_id, conversation_id,
status, termination_reason, quality_status,
session_id, model_used, model_role, execution_tier, model_fallback_reason,
started_at, updated_at, ended_at, heartbeat_at,
turns_used, active_ms, waiting_ms,
last_event_id, latest_checkpoint_json,
error_code, error_message
```

`run_events` 至少包含：

```text
id INTEGER PRIMARY KEY AUTOINCREMENT,
run_id, conversation_id, instance_id,
event_type, event_json, created_at
```

- `run_events.id` 是全局持久 cursor。
- 不复用 `chat_agent_events`，因为它依附 assistant message 且词表用途不同。
- migration 编号必须执行 main/worktree/local DB 三查。

### 2. Persistence Policy

持久化：

- `run_started`
- `message_completed`
- `tool_completed`
- `compaction_completed`
- `run_ended`
- `run_state_changed`
- `run_settled`
- 周期 checkpoint

不持久化：

- 每个 `message_delta`
- thinking delta
- 全量 partial 快照

重建现场使用最近 checkpoint + 之后的持久事件。

### 3. Canonical Settled

- 保持 AR2a outcome `completed|aborted|error`。
- 每 Run 的持久日志恰好一条 canonical settled。
- 重复发射通过唯一约束/幂等写被折叠。
- settled 之后拒绝新的该 runId 业务事件；conversation 级 title update 不属于 Run。
- 当前实时帧仍可重复送达，客户端按 eventId 去重。

### 4. APIs

```text
GET /api/agent/runs/:runId
GET /api/agent/runs/:runId/events?afterEventId=N&limit=M
```

- 返回稳定 schemaVersion。
- `afterEventId` 为排他 cursor。
- 有更多数据时返回 next cursor。
- 不使用 EventSource 的隐式 Last-Event-ID；客户端显式传参。
- 越权 conversation/runId 返回 404，不泄漏存在性。

### 5. Checkpoints

在 tool completed、compaction、等待入口、阶段完成和 Run 收尾时写 checkpoint。

- checkpoint 写入采用 upsert，并同时记录对应 lastEventId。
- checkpoint 不包含高风险权限 grant。
- 文件只记录规范化路径、hash 和工作状态。
- 正在执行的 Python/LO 进程不被宣称可恢复。

### 6. Model Routing Integration

本包消费 CR-M1 的 `ResolvedModel`，在 Router 分类之后完成真实接线：

- SDK option.model。
- `ANTHROPIC_MODEL`。
- agent_runs model 字段。
- trace model 字段。
- usage executionTier。

Router 超时、非法响应或关闭时使用 `mainModel` 并保存 fallback reason。禁止在 Query Pipeline 重新实现槽位规则。

### 7. Trace Semantics

- 创建 Run 时先写 `queued`，Runtime 取得执行权后转 `running`。
- 删除 outcome=`slow`；耗时仅为指标。
- 用户停止、系统 timeout、模型错误和客户端断开不得合并成同一错误。
- 客户端断开本包只记订阅审计，不终止 Run 的行为由 CR-R2 完成。
- result 消息缺失时使用已累计 usage，不可归零。

### 8. Compatibility

- 旧 `done/incomplete/error` 保留，直到 CR-R2 完成 UI 切换。
- 新 replay API 只服务新 Run；历史消息继续从现有聊天表读取。
- `contractToLegacyEvents` 行为保持不变。

## File Ownership

允许：

- Run/event DB migration 与 store。
- runtime event persistence adapter。
- Query Pipeline 的模型解析接线。
- replay API、trace/usage 写入。
- 对应单元、DB 和 API 测试。

禁止：

- 后台 RunManager、SSE 生命周期解耦。
- resume/stop UI。
- 权限 capability。
- deliverable/validator。
- 修改 AR2a outcome union。

## Testing Decisions

- migration/up/down 或项目既有迁移模式。
- settled 唯一约束与三 outcome。
- delta 不落库、checkpoint + events 可重建。
- replay pagination、cursor、去重。
- crash 前已有事件仍可读。
- 中断回合 usage 不归零。
- complex workflow 的 SDK/env/run/trace 均使用 mainModel。
- Router fallback reason 三分支。
- 复用 runtime-events、query-stages、usage 和 DB 测试接缝。

## Acceptance Criteria

1. 每个新 Run 创建即有 agent_runs 记录。
2. 持久 eventId 全局单调，重放不依赖内存 emitter cursor。
3. 每 Run 恰好一条持久 settled，AR2a outcome 三值不变。
4. checkpoint + 后续事件可以重建已完成步骤和文件列表。
5. 高频 delta 不进入 SQLite。
6. 中断和错误路径保留真实模型、fallback 和 usage。
7. replay API 定向测试、全量 DB 测试、typecheck 和 lint 通过。

## Out of Scope

- SSE 断开后继续运行。
- 进程重启恢复执行。
- paused/resume 和动态预算。
- UI 权威完成态切换。
- 文件质量门。

## Further Notes

CR-R2 在本包之上建设 RunManager 和客户端恢复；不得把本包描述成已经解决断线继续执行。

