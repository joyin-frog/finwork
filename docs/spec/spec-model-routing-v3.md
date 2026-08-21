# Spec：两模型与执行角色分离

> 状态：已实施
> 日期：2026-08-14
> 取代：`spec-model-routing-v2.md`

## 用户模型

产品只配置两个模型：

- `fastModel`：成本优先，Router 与主 Agent 默认使用。
- `reasoningModel`：能力优先，用户在对话框开启深度思考时使用，也供复杂子任务使用。

项目尚未正式上线，不保留旧三槽迁移。设置合同和设置文件从本版起只接受两个字段。

## 执行规则

| 执行者 | 默认档位 | 升档方式 |
|---|---|---|
| Router / 标题 | fast | 不升档 |
| 主 Agent / 专员会话 | fast | 用户在对话框选择 reasoning |
| 子 Agent | fast | 模板或派发任务将复杂度标为 complex |

Router 的 intent 只决定 direct/agent、检索与任务合同，不得改变主 Agent 模型。Router 超时、
关闭或返回非法结果时保留失败原因，但仍尊重用户本回合选择，禁止静默升档。

子任务的模型选择是任务元数据，不是第三个模型配置：单次检索、读取、结构化检查走 fast；
跨文件综合、公式恢复、复杂交付物走 reasoning。固定模型 Agent 评测可以覆盖主会话和所有嵌套
worker，以保证评测隔离，但不得改变生产配置。

## 可观测性

一次模型选择分别记录：

- `executionRole`: `router | agent | subagent`
- `executionTier`: `fast | reasoning`
- `modelId`: Provider 实际模型 ID

执行角色回答“谁调用”，模型档位回答“成本/能力等级”，两者不得再合并成槽位名。

## 验收

1. 设置只接受并落盘 `fastModel/reasoningModel`，不存在旧三槽兼容路径。
2. 默认主 Agent 即使被 Router 判为 `complex_workflow` 也使用 fast。
3. 只有对话框显式选择 reasoning 才升级主 Agent。
4. 子任务模板均声明 fast/reasoning；自由派发默认 fast、complex 使用 reasoning。
5. 固定模型评测仍强制主会话与嵌套 worker 使用同一模型。
