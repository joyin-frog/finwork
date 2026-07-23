# Spike：Claude SDK 自动分段、暂停与恢复控制点

> ID：CR-X1  
> 状态：Completed · PARTIAL · 见 `spike-sdk-segment-control-findings.md`  
> 类型：验证性 Spike，不实施产品功能  
> 日期：2026-07-21  
> 时间盒：1–2 个工作日

## Question

Finwork 不拥有 agent loop，Claude Agent SDK 拥有。需要验证现有 SDK 是否能可靠支持：

1. 达到 segment turns 后不中断 runId 地继续。
2. pause/stop 时 interrupt 当前 Query。
3. resume 时复用 session 或重建上下文。
4. quiesce 后保证不再发生模型事件和工具写入。
5. 区分用户 stop、预算暂停和 SDK 错误。

没有这些证据，不实施“自动 240 turns 分段续跑”。

## Known Controls to Verify

- Query `interrupt()`。
- streaming input / `streamInput()`。
- SDK session resume。
- maxTurns 结果 subtype。
- AbortController 与 SDK result/event 时序。
- tool callback 完成与 interrupt 的竞态。

以当前安装的 SDK 类型和真实运行行为为准，不只阅读类型声明。

## Experiment Matrix

### E1. Interrupt during model generation

- 启动持续输出任务。
- 调 interrupt。
- 记录最后事件、result subtype、session 可否 resume。

### E2. Interrupt during run_python

- 启动可控长 Python 子进程。
- interrupt SDK Query。
- 验证 Python 是否继续运行、谁负责 kill、是否仍写文件。

### E3. maxTurns boundary

- 将 maxTurns 设小。
- 触发边界。
- 验证是否得到稳定 session、可否在不注入虚假用户“继续”的情况下恢复。

### E4. streamInput continuation

- 保持输入流开放。
- 在工具阶段后投递新输入。
- 确认输入进入当前 turn、下一 turn 或被拒绝的准确时点。

### E5. Repeated resume

- 同一 session 连续 resume 三次。
- 检查上下文、usage、工具幂等和 session 失效行为。

### E6. Quiesce invariant

- pause 前记录文件 hash/event cursor。
- interrupt + kill 子进程 + checkpoint。
- paused 提交后观察至少一个 kill timeout 窗口。
- 不得出现新事件或文件变化。

## Evidence Required

- 最小复现脚本/测试，不进入产品路径。
- 每个实验的事件时间线。
- SDK 版本、平台和模型。
- result subtype/stderr。
- Python/LO 子进程 pid 与退出状态。
- session resume 成功/失败证据。

## Decision Outcomes

### PASS

可立 `spec-run-auto-segmentation.md`，必须明确：

- 自动 segment 边界。
- budget epoch。
- interrupt/kill 顺序。
- 幂等 checkpoint。
- resume 失败降级。

### PARTIAL

只实施显式用户 resume；不做无感 segment。CR-R2 维持 v1 方案。

### FAIL

maxTurns/time 到达后标记 paused，用户新建 Run 继续；不声称原 Run 自动续跑。

## Out of Scope

- 修改生产 Adapter。
- UI。
- 替换 SDK。
- 构建第二套 agent loop。

## Deliverable

新增 `spike-sdk-segment-control-findings.md`，包含结论、证据、允许立项范围和被否决方案。

