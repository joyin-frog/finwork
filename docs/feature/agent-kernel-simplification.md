# Finwork Agent Kernel 收口执行规格

> 状态：已完成 · 2026-08-20
> 原则：不做兼容迁移；新路径成为唯一生产权威，旧桥接随切换删除。

## 1. 目标

把生产热路径收敛为：

```text
Request → Pi Agent Session → Tool Executor → Handler → Check → Answer/Delivery
```

Pi 是唯一的任务决策循环。Harness 只承担权限、沙箱、资源、确定性校验、文件版本和正式交付，不再维护第二套 Agent 规划。

## 2. 三种任务

| 类型 | 路径 | 持久 Plan | Artifact/Evidence | 完成条件 |
|---|---|---:|---:|---|
| `chat` | Pi → answer | 否 | 否 | assistant 正常结束 |
| `action` | Pi → tool → check → answer | 否 | 仅 ToolReceipt | 工具结果或正常回答 |
| `deliverable` | Pi → tool/script → check → delivery | 按需 | 是 | 正式产物通过阻断校验 |

只有存在 required deliverable 的任务进入完整交付治理。附件、复杂措辞或调用工具本身，不再自动创建 Case/DAG/Evidence。

## 3. 唯一权威

| 领域 | 唯一权威 | 删除/停止新增 |
|---|---|---|
| Agent 决策 | Pi Session | Harness Planner 推断下一步 |
| 运行事件 | `AgentRuntimeEvent` journal | envelope/legacy 双写语义 |
| 工具执行 | `FinanceCapabilityRuntime.execute` | rollout epoch、透传 gateway、重复 ledger |
| 文件状态 | workspace current head | 多个无父子关系的候选文件 |
| 工具事实 | execution receipt | 每层各记一份“执行证据” |
| 正式完成 | validator + immutable delivery | 模型自报完成、`not_applicable` 伪证据 |

## 4. 必须保留

- Pi 会话、steering、AskUserQuestion、Subagent 隔离。
- 工具授权与用户确认、沙箱、资源预算、网络出口控制。
- 单一文件 workspace、父子版本、`stale_base_version`。
- LibreOffice/产品 Provider 重算、格式/公式/财务校验。
- 内容寻址的不可变正式交付。
- 真实来源引用；高风险产物的审计事实。

## 5. 必须删除或合并

- `CapabilityFoundationRollout`、`CapabilityFoundationGateway` 及其 dev API/test。
- 生产 TaskContract 双语义；请求分类用 `AgentTaskSpec`，正式交付用 `DeliverySpec`。Eval 的 V3 Oracle 合同仅留在评测边界。
- 普通 Chat/Action 的 ProductionTask/Case/WorkPlan/Evidence 初始化。
- Production runtime 与 Pi runtime 的重复 `CapabilityExecutionLedger`。
- 只保护旧 bridge、shadow、migration、内部调用顺序的测试。
- package scripts 中历史 spike、重复别名和同一测试多次串联。

已完成的工具减法：

- `search_knowledge` 合并 `query_knowledge` 与 `read_file` 的检索/精读能力。
- `patch_workspace_workbook` 内置 `begin_workspace_change` 与 `review_workspace_change`。
- `process_voucher_batch` 内置金额勾稽、科目映射、分录构造、清单与汇总五步。
- `check_workbook_ties`、`detect_data_issues`、`merge_labeled_tables` 不再作为模型工具；特殊逻辑写任务脚本，交付由 Validator 阻断。
- Pi builtins 与领域工具分开登记；普通 Chat 只有读、搜、提问，文件任务才增加写脚本能力。

已完成的底座减法：

- 删除旧知识库 `rg` 查询栈、named mirror 和 chunker；知识检索只走 FTS5 + BM25，Pi 的 `grep` 仍单独使用打包 `rg`。
- 删除 Claude MCP server 包装层；领域工具只产出 `FinanceToolDefinition[]`，由 Pi adapter 直接注册。
- 工具风险确认、角色范围与请求上下文只在 authorizer/context policy 判定一次；Pi builtin 的路径和沙箱边界仍由 Pi executor 负责。
- 删除旧 `memory.md` API、逐回合 migration 和 migration log；Prompt 只读取已经批准且与本轮相关的 governed memory。
- 删除 rollout/shadow 数据表、旧 Golden/AS0 executable suite 和只保护旧抽象的源码快照测试。
- 文件读写与 Workbook patch 统一从 `workspace current head` 解析父版本，修复不再回到上传基线。

## 6. Eval 收口

Eval 保留三个互斥的执行视角：

1. **Harness**：无模型、确定性地验证权限、沙箱、版本、恢复和交付门禁。
2. **Agent**：用固定模型跑完整 Pi + 工具 + 交付路径，评估真实 Agent 能力。
3. **Model**：只跑无工具的答案推理，用于比较模型，不得冒充 Agent 分数。

三者共用 Case、执行记录、私有 Oracle 和报告格式；**Outcome 是每个视角的统一评分结果，不是第四层**。不再为 Router、Planner、Capability Foundation 各复制一套评分，也不提供 `mixed` 模式。性能作为诊断字段，不作为正确性的硬门。

保留两组发布级样本：30-case General Agent Pilot，以及历史真实财务工作簿。Fixture 只验证执行器和 Oracle 本身，不冒充 Agent 能力。

## 7. Test 收口

测试仅保留四类：

- `unit`：纯函数、解析、计算、validator。
- `boundary`：权限、沙箱、文件版本、Tool Executor、Delivery。
- `agent`：Pi 事件/提问/工具循环的少量合同测试。
- `eval`：30-case 与历史财务任务。

删除标准：测试仅验证已删除抽象、重复覆盖同一合同、依赖内部调用顺序、没有可能失败的业务断言，或被更高层边界测试完整包含。

## 8. 验收

- Chat/Action 不创建 Case、WorkPlan、输入 Evidence。
- Deliverable 仍在校验失败时禁止 finalize。
- 工具只经过一个生产 executor，避免性工具失败为 0。
- 文件修复始终沿 current head 增量执行。
- 30-case 与历史工作簿使用同一生产入口和私有 Oracle。
- 主测试入口不重复运行同一测试；删除旧层后无对应结构快照测试。

当前收口验证：`test:core` 27/27、Pi Agent（含外层真实 Seatbelt）、Eval Kernel、工作簿回归、package-manager 一致性和生产 `next build` 全部通过；角色 governed memory 的添加与回显也已做真实页面截图。Eval Kernel 此处证明执行器、Case、Oracle 和 30-case 结构门，不等同于重新付费跑模型；历史财务工作簿与真实 Agent 分数不沿用删减前结果。

角色详情页的手工记忆入口也已切到 governed memory：用户在设置页点击添加即是明确批准，对话工具仍只能提交候选；旧 `role_memory` 表、store 与 API 实现已删除。
