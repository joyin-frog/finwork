# Spec：持久 Run 状态、断线恢复与聊天 UI 切换

> ID：CR-R2  
> 对应 ROADMAP：AR2c + AR4  
> 状态：Blocked — 等待 CR-R1  
> 日期：2026-07-21  
> 前置依赖：CR-R0、CR-R1；自动分段能力另依赖 CR-X1 结论  
> 下游：CR-P1

## Problem Statement

当前 Agent 绑定浏览器 POST-SSE 请求；页面关闭、网络断开和用户停止最终会走相同 abort 链。UI 仍以旧 `done/incomplete/error` 帧决定完成状态，“继续”通过发送文本开启新回合，不是恢复 Run。固定 10 分钟、30 turns 和 15 次 Python 调用也会误杀长任务。

## Solution

建立服务端 RunManager，使 Agent 生命周期独立于订阅连接；客户端使用 CR-R1 的持久事件和 checkpoint 重连。Run 状态成为 UI 权威来源。v1 放宽预算、移除成功调用次数限制，并提供显式 paused/resume；自动无感 segment 续接只有 CR-X1 证明 SDK 控制点后才进入实施。

## User Stories

1. 作为用户，我希望切页或断网后任务继续执行。
2. 作为用户，我希望重新进入对话时看到真实阶段和最近步骤。
3. 作为用户，我希望停止按钮只表示我主动停止。
4. 作为用户，我希望系统超时、等待授权和验证失败有不同提示。
5. 作为用户，我希望复杂任务不会因为 15 次成功 Python 调用被打断。

## Implementation Decisions

### 1. RunManager

- `POST /api/agent/query` 创建/排队 Run，立即返回 runId 和订阅入口。
- SDK Query 由服务端 RunManager 持有，不使用浏览器 request.signal 作为生命周期信号。
- SSE/Web stream 仅是订阅；disconnect 记录审计，不改变 Run 状态。
- 显式 stop API 是用户停止的唯一入口。
- 同一 conversation 只允许一个 `queued/running/waiting_*` 主 Run；`paused` Run 可以保留，但新任务前必须选择恢复、取消或放弃旧 Run。

### 2. APIs

```text
POST /api/agent/runs/:runId/stop
POST /api/agent/runs/:runId/resume
GET  /api/agent/runs/:runId
GET  /api/agent/runs/:runId/events?afterEventId=N
```

“继续”按钮调用 resume API，不再自动发送用户消息“继续”。用户主动输入新业务信息时仍是新 user message；若存在 paused Run，UI 先让用户选择将信息作为恢复补充还是新任务。

### 3. Authoritative UI Status

- UI 状态来源切换为持久 Run status + quality status。
- 旧 `done/incomplete/error` 在迁移期仍解析文本，但不能单独将需要文件的 Run 标成成功。
- `completed` 必须来自 RunStore CompletionGate。
- `waiting_user/waiting_dependency/paused` 不发 settled，也不显示成功。
- `run_settled` outcome 继续使用 AR2a 三值映射。

### 4. Disconnect and Restart

- 断线后 Run 继续，事件持久化。
- 重连显式携带 lastEventId，按 at-least-once 去重。
- 应用进程重启时，旧 `running` Run 标记为 `paused/process_crash`。
- 恢复的是 checkpoint、历史、已完成工具和文件现场，不宣称恢复正在执行的 Python/LO 子进程或未提交事务。
- session 有效时 resume；失效时使用历史与 checkpoint 摘要重建。
- 未确认高风险动作必须重新确认。

### 5. v1 Run Policy

```text
fast:      maxTurns 50, hard active 20m, idle 5m
reasoning: maxTurns 80, hard active 60m, idle 8m
```

- 删除 `MAX_PY=15` 总调用次数规则。
- 卡住判断改为同一工具、同一规范化错误连续 5 次且无可验证进展。
- 可验证进展仅包括成功工具结果、文件 hash 变化、阶段 checkpoint 或 deliverable 状态变化；普通 thinking/进展文本不重置 idle。
- 等待用户/依赖时间不计 active/idle。
- 达到 turns/time 在 v1 进入 `paused/budget_exhausted|hard_timeout|idle_timeout`。
- 用户显式 resume 开启新 budget epoch，保留 lifetime 累计，默认最多 3 次。
- 自动 segment 续接不在 v1，等待 CR-X1。

### 6. Pause and Stop

公开写入 paused/canceled 前必须 quiesce：

1. interrupt/cancel 当前 SDK Query。
2. 终止或确认退出受管 Python/LO/安装子进程。
3. 写 checkpoint。
4. 撤销当前写 capability。
5. 原子更新状态。

状态提交后不得继续调用模型、执行工具或修改工作文件。kill timeout 后允许强制终止并记录结果。

### 7. Status Presentation

UI 至少区分：

- 排队中。
- 正在执行。
- 等待确认。
- 等待安装依赖。
- 已暂停，可恢复。
- 验证失败，可修复。
- 用户已停止。
- 系统错误。
- 已完成且质量通过。

最近步骤从 checkpoint + replay 构建，不从“有没有 trace”猜测 running。

## File Ownership

允许：

- RunManager、run lifecycle APIs。
- Query request/stream 生命周期。
- client replay/resume/stop。
- Chat TurnStatus 与 recent work 状态。
- budget/stuck guard。

禁止：

- 修改 CR-R0 共享状态词表。
- 修改 AR2a settled outcome 三值。
- validator、Spreadsheet Runtime。
- Python 路径沙箱实现。
- 未经 Spike 实施自动 segment 续接。

## Testing Decisions

- SSE disconnect 后 Agent 继续并最终落库。
- 重连 replay 不重复 UI 步骤。
- stop 传播到 SDK/Python/LO，之后不再写文件。
- restart 将孤儿 running 标记 paused/process_crash。
- 旧 done 无质量证据时不能显示文件任务成功。
- 60 次成功 Python 不触发 stuck。
- 相同错误第 5 次暂停；成功后清零。
- budget epoch 第 4 次 resume 被拒。
- thinking 文本不重置 idle fake clock。

## Acceptance Criteria

1. 页面切换和网络断开不终止 Run。
2. 用户 stop 为 canceled + settled(aborted) + user_stop。
3. 系统错误为 failed + settled(error) + 具体 reason。
4. waiting/paused 不发 settled。
5. UI 权威完成态来自持久 Run 和 CompletionGate。
6. 固定 10m、30 turns、15 Python 限制被明确替换。
7. 进程重启后状态可解释、可恢复，不永久 running。
8. 自动 segment 未经 Spike 不进入实现。

## Out of Scope

- 恢复正在运行的子进程。
- 自动 segment 续接。
- 多设备同步。
- 多个并发主 Run 写同一 conversation。

## Further Notes

本包是第一期“体验不再极差”的核心；只有持久事件而没有 RunManager，不能宣称断线恢复已完成。

