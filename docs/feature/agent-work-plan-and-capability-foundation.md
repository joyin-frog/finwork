# Agent WorkPlan 与统一能力底座

更新日期：2026-08-15

## 结论

Finwork 的生产 Agent 已从“单个 `agent.turn` 节点内由模型临场决定一切”收口为后端权威链路：

`TaskContract → Preflight → WorkPlan/DAG → Capability → Evidence → Validator → Delivery`

本次不实现计划 UI。后端已经提供稳定的计划数据、持久事件和只读查询接口，未来前端只消费这些事实，不自行推断步骤或完成状态。

## 当前实现

### 1. WorkPlan 与真实 DAG

每个生产任务在模型调用前生成并持久化业务计划。复杂任务根据合同、输入、必需能力、交付物、人工决策点和路由意图生成 3–8 个步骤：

- 检查任务条件与可用能力
- 读取并核对输入材料
- 收集并引用所需证据
- 协调所需专业角色
- 执行分析与处理
- 生成约定交付物
- 验证结果与证据
- 完成受控交付

计划步骤是可展示的业务语言，不包含模型隐藏推理。每个步骤关联一个 `case_node`，节点之间以依赖边组成 DAG，不再把整个任务压缩成唯一的 `agent.turn` 节点。

计划由后端写入模型上下文。模型可以看到目标、步骤和预期结果，但无权自行把步骤改成完成；状态只能由工具事实、Evidence、Validator 和 Delivery Gate 推进。

### 2. 确定性 Preflight

Preflight 在模型调用前逐项检查 `TaskContract.requiredCapabilities`：

- 当前能力目录是否存在至少一个候选工具；
- 必需能力缺失时是否应阻断；
- 检查时间、候选工具和原因是否已落库。

必需能力缺失会以 `foundation_preflight_failed` 失败关闭，不再让模型先运行、最后才发现基础能力不存在。

### 3. Capability Foundation 单一生产权威

Capability Foundation 现在是工具执行的唯一生产权威：

- `ensureInitialized()` 会把全新库或遗留的 shadow/legacy 活跃 epoch 原子切到 `cutover/new`；
- 生产 Gateway 只有一个 `next` executor；
- 不做双读、双写或运行时 legacy fallback；
- `beginShadow()` 和 `rollback()` 已退役并显式拒绝；
- 旧 FinanceTool handler 仍是业务实现，但只能由 `CapabilityExecutor` 注册和调用一次，不能绕过资源、权限、attempt 与结构化失败账本。

这意味着“旧 handler 代码仍存在”不等于“legacy 执行路径仍有权威”。

### 4. 计划完成门禁

任务完成需同时满足：

1. 必需能力存在成功执行事实；
2. 所有阻断 WorkPlan 步骤已完成；
3. 约定产物已进入 ArtifactStore；
4. 必需 Evidence 与 Validator 断言存在且通过；
5. Delivery Gate 通过。

助手文本不能代替上述任一事实。计划未完成会返回 `foundation_plan_incomplete`；能力事实缺失会返回 `foundation_required_capability_missing`。

### 5. 崩溃恢复

启动时仍处于 queued/running/waiting 的 Run 会先被标记为 `paused/process_crash`，随后同步恢复任务现场：

- 已成功步骤保持成功，不重复执行；
- running/ready/verifying/waiting 步骤标记为 `interrupted`；
- 未结束 attempt 以 `process_interrupted` 失败收口；
- Case 进入 `repairing`；
- 保存带 hash 的恢复 checkpoint；
- 只有具备 idempotency key 的未完成步骤才被标为可安全重试。

这不是“恢复原进程”。运行到一半的模型请求、Python 进程和未提交事务不会被伪装为仍在运行；恢复的是已确认现场，后续从 checkpoint 对未完成步骤发起新 attempt。

## 为未来 UI 保留的合同

### 查询接口

`GET /api/agent/runs/:runId/plan`

返回：

- 当前计划及步骤状态；
- Preflight 结果；
- Run 暂停时的恢复合同；
- 是否可安全重试、可重试步骤和阻塞步骤；
- `exactProcessContinuation: false`，防止 UI 误导用户。

接口不会返回工具参数、敏感数据或隐藏推理。

### 持久事件

- `work_plan_created`
- `work_plan_revised`
- `work_plan_step_changed`

事件进入 `run_events`，但暂不映射到旧聊天 UI。未来可以直接实现步骤列表、进度条或折叠式计划卡，不需要改后端任务模型。

## 数据表

- `case_plan_versions`：版本、目标、来源与终态；同一 Case 只有一个 active 版本。
- `case_plan_steps`：稳定 step key、标题、预期结果、状态和结果摘要。
- `case_plan_step_nodes`：用户可读步骤与执行 DAG 节点的映射。
- `case_preflight_results`：必需能力与候选工具检查结果。
- 既有 `case_nodes` / `case_edges` / `case_step_attempts` / `case_checkpoints` 继续作为执行与恢复账本。

## 尚未做的 UI

本次有意不实现：

- 对话中的计划卡片；
- 步骤展开、折叠和进度动画；
- 用户编辑或批准计划；
- 中断后的“一键继续”按钮。

这些不是后端能力缺失。前端设计确定后，可以直接消费现有 API 与事件。

## 后续可提升点

1. 增加受控 replan 命令：保留已成功步骤，只允许新增或替换未开始节点，并生成新 plan version。
2. 将恢复合同接到正式“继续执行”命令，由后端创建新 attempt，而不是让前端拼接提示词。
3. 用真实 Win11 MXC 设备矩阵验证 AppContainer、长任务、大文件、安装包 smoke 和崩溃恢复。
4. 对真实财务任务做人工验收，重点核对计划是否贴合业务过程，而不只看最终文件是否生成。

第 3、4 项属于发布验证，不能由 macOS 本地单元测试替代。
