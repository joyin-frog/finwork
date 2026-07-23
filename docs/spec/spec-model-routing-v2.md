# Spec：模型配置与路由语义 v2

> ID：CR-M1  
> 状态：已ship（Batch 0）· 见 `audit-model-routing-v2.md`  
> 日期：2026-07-21  
> 前置依赖：无  
> 下游：CR-R0、CR-R1  
> 所有权：模型设置、迁移、设置 UI/API、纯 resolver、标题/摘要/子代理等独立消费者

## Problem Statement

当前设置类型虽然包含 `mainModel/routerModel/subagentModel`，但设置 UI 没有保存 `mainModel`，“推理模型”实际写入 `subagentModel`；复杂任务和显式 reasoning 也读取 `subagentModel`。Router、标题还存在硬编码 Claude 型号回退。结果是 UI 概念、运行时模型、usage 档位和 trace 标签互相矛盾。

## Solution

建立原子 ModelConfig v2 和唯一纯模型解析器：

| 槽位 | 语义 | 档位 |
|---|---|---|
| `mainModel` | 复杂主任务、显式推理、专员会话、摘要 | reasoning |
| `routerModel` | Router、标题、普通快速任务 | fast |
| `subagentModel` | 子代理 | fast |

本包只交付设置与纯解析合同，不修改 Query Pipeline、主 Adapter、RunStore 或 trace。实际 Query 接线归 CR-R1。

## User Stories

1. 作为用户，我希望设置页的“推理模型”真正控制复杂任务模型。
2. 作为用户，我希望“快速模型”同时用于 Router 和子代理，减少配置复杂度。
3. 作为管理员，我希望模型配置要么整体缺失，要么三槽完整，避免静默回退。
4. 作为开发者，我希望所有模型消费者使用同一 resolver，避免第二套路由规则。
5. 作为成本管理员，我希望相同模型 ID 占多个槽时仍按调用角色正确归档用量。

## Implementation Decisions

### 1. Atomic ModelConfig

持久配置逻辑形态：

```ts
type ModelConfigV2 = {
  version: 2;
  mainModel: string;
  routerModel: string;
  subagentModel: string;
};

type ModelConfigState = ModelConfigV2 | null;
```

- `null` 表示用户尚未配置在线 Agent；本地浏览能力仍可使用。
- 非空配置的三个字段必须同时非空。
- 模型 ID trim 后长度限制为 1–200，禁止换行和控制字符。
- 不允许保存部分配置，也不允许后端保留旧值来伪装空字段保存成功。
- `settings.model` 只参与一次迁移，迁移后不再参与运行时选择。

### 2. Legacy Migration

```text
mainModel = old.mainModel || old.subagentModel || old.model
routerModel = old.routerModel || old.model || old.subagentModel
subagentModel = old.routerModel || old.model || old.subagentModel
```

- 只有三个值都可推导时才写入 v2。
- 全空配置迁移为 `null`。
- 旧 `subagentModel` 优先迁入新 `mainModel`，因为旧 UI 将它称为推理模型。
- 新 `subagentModel` 优先使用旧 `routerModel`，因为新语义中二者都属于快速档。
- 迁移带 version，必须幂等。
- API Key 继续只进入 secret store。

### 3. Settings UI and API

普通 UI 只展示两个输入：

- 快速模型 `fastModel`
- 推理模型 `reasoningModel`

保存映射：

```text
routerModel = fastModel
subagentModel = fastModel
mainModel = reasoningModel
```

- 后端原子校验和写入；任一输入为空返回 400 和字段级错误，磁盘保持不变。
- 前端必须检查 HTTP status，错误响应不能显示“已保存”。
- 用户将两个输入配置成相同 ID 时允许保存，但显示“当前没有实际模型分层”提示。
- Doctor 返回 `modelConfigReady` 与 `missingModelRoles`。
- Agent 入口在配置未就绪时返回稳定错误 `MODEL_CONFIG_INCOMPLETE` 和设置入口，不调用 SDK。
- 高级设置拆分子代理模型不属于本期。

### 4. Pure Resolver

```ts
type ModelRole = "main" | "router" | "subagent";
type ExecutionTier = "reasoning" | "fast";

type ResolvedModel = {
  modelId: string;
  modelRole: ModelRole;
  executionTier: ExecutionTier;
  fallbackReason?: "router_timeout" | "router_invalid" | "router_disabled";
};
```

解析矩阵：

| 场景 | modelRole | modelId |
|---|---|---|
| Router 分类 | router | `routerModel` |
| 标题生成 | router | `routerModel` |
| 普通任务 + fast | router | `routerModel` |
| complex workflow + fast | main | `mainModel` |
| 任意任务 + reasoning | main | `mainModel` |
| 专员会话 | main | `mainModel` |
| 子代理 | subagent | `subagentModel` |
| 历史摘要 | main | `mainModel` |

Router 超时、非法 JSON 或关闭时 fail-safe 到 `mainModel` 并返回 fallbackReason。不得因为无法分类而使用快速模型。

### 5. Independent Consumers

本包可修改以下独立消费者，使其直接读取新配置或 resolver：

- Router 调用本身。
- conversation title。
- recap summary。
- subagent runner。
- usage tier 纯分类。

usage 以本次 `executionTier` 为准，不再通过模型 ID 与槽位字符串匹配。模型 ID 相同时也能正确分类。

### 6. Removed Behavior

- 删除硬编码 Claude 默认型号。
- 删除 SDK 默认模型回退。
- 删除运行时 `settings.model` 回退。
- 删除“complex workflow 使用 subagentModel”的旧语义。
- 删除或改写未接入真实管线的第二套自动升级函数。

## File Ownership

允许：

- Settings schema/store/migration。
- Settings API、设置页和首启模型配置。
- 纯 model-config/model-resolver 模块。
- 标题、摘要、子代理和 usage 的独立模型消费者。
- 对应单元、API 和 UI 测试。

禁止：

- Query stage、Query route、主 Adapter。
- Run 状态、runtime events、trace 持久化。
- Spreadsheet、权限或交付模块。

Query Pipeline 接线和真实 trace 验收由 CR-R1 负责。

## Testing Decisions

### Unit

- `null` 与完整 v2 合法；部分配置非法。
- trim、长度和控制字符。
- 三类旧配置迁移和幂等。
- resolver 全矩阵。
- Router 三种失败原因均返回 mainModel。
- 相同模型 ID 下 executionTier 仍正确。

### API/UI

- 合法保存、重新读取。
- 空字段 400，文件不变。
- 前端错误不显示已保存。
- 首启完成后三槽非空。
- 未配置时 Agent 入口被 readiness 阻断。

### Existing seams

- router direct/continuation tests。
- agent query helper tests。
- usage quota/store tests。
- recap summary tests。
- settings smoke 和 Playwright 设置页。

## Acceptance Criteria

1. ModelConfig 只能为 `null` 或完整 v2。
2. 旧配置按既定规则迁移且不丢失旧推理模型。
3. 设置页展示快速/推理两个真实概念。
4. 纯 resolver 对复杂任务返回 `mainModel/reasoning/main`。
5. Router 失败返回 `mainModel` 与 fallbackReason。
6. 子代理消费者使用 `subagentModel/fast/subagent`。
7. 代码运行路径不再出现 `settings.model` 或硬编码模型 fallback。
8. 本包定向测试、typecheck 和 lint 通过。

## Out of Scope

- Query Pipeline 和 trace 接线。
- 网关模型列表自动发现。
- 多 Provider Runtime。
- 为快速/子代理分别增加两个普通 UI 输入。

## Further Notes

CR-R1 必须把本包的 `ResolvedModel` 原样传给 SDK options、环境变量、Run 和 trace，不能重新计算模型角色。

