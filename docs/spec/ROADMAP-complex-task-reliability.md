# ROADMAP：复杂文件任务可靠执行与可信交付

> 状态：Design Approved / Batch 0 in progress  
> 版本：v1.1  
> 日期：2026-07-21  
> 来源：Codex 任务 `019f832e-76ef-7573-9645-502499650c2c` 与 Finwork 本地会话 9、10、11 对比诊断  
> 设计审查：`audit-complex-task-reliability.md`  
> 性质：跨功能路线图，不可直接作为单个实施任务派发  
> Batch 0（2026-07-21）：CR-M1 / CR-S1 Runtime Core / CR-X1 已落地；见各包 audit

## 1. Problem Statement

同一份母子公司合并报表任务在 Codex 中能够完成、复核并交付，在 Finwork 中却经历三个重叠会话、七个回合、多次权限等待、10 分钟超时和 30 turns 截断。唯一声称完成的工作簿经真实公式重算后仍存在资产负债不平与现金不平。

问题由五条链路共同造成：

1. 模型槽位语义与 UI/Router 不一致，复杂任务没有稳定使用 `mainModel`。
2. Spreadsheet skill 只有指导文本，缺少 `.xls`、公式重算、渲染和依赖预检的产品能力。
3. Agent Run 依附请求/SSE，固定 timeout、maxTurns 和 Python 次数保护会误杀正常长任务。
4. conversation 级 Python 信任不是持久 Run 权限，也没有完整路径边界。
5. 文件交付只相信模型声明，不验证文件、公式、期间、公司和财务勾稽。

## 2. Solution

将问题拆成可独立审计、顺序明确的功能包，并保留现有 AR2a 事件合同：

```text
Model Routing v2 ───────────────────────────────────────┐
                                                       │
AR2a(已 ship) → Run Contract v2 → AR2b 持久事件 ───────┼→ Run 恢复 UI
                                      │                │
                                      ├→ Run 权限      │
                                      └→ CompletionGate│
                                                       ├→ 集成验收
Spreadsheet Preflight → 通用交付门 → 合并报表 Validator ┘

SDK Segment Spike ─→ 是否立自动分段/暂停执行包
Managed LO Spike ──→ 是否立托管 LibreOffice 分发包
```

## 3. Non-negotiable Decisions

### 3.1 模型

- `mainModel`：推理模型，用于复杂主任务、显式推理、专员会话和摘要。
- `routerModel`：快速模型，用于 Router、标题和普通快速任务。
- `subagentModel`：快速模型，用于子代理。
- 模型配置只能整体缺失，或三个槽位同时非空；禁止半配置、SDK 默认模型和硬编码厂商模型回退。
- 相同模型 ID 可以占多个槽，但 usage 必须按调用时的 `modelRole/executionTier` 分类。

### 3.2 AR2a 兼容

已 ship 的 `run_settled` 词表保持不变：

```text
completed | aborted | error
```

Run 状态映射：

| Run 状态 | `run_settled.outcome` | `termination_reason` |
|---|---|---|
| `completed` | `completed` | 空 |
| `canceled` | `aborted` | `user_stop` 等 |
| `failed` | `error` | 具体错误原因 |
| `waiting_user` / `waiting_dependency` / `paused` | 不发 settled | 暂停或等待原因 |

- `run_settled` 每 Run 恰好一次，只在真正终态发射。
- 传递语义保持 at-least-once，客户端按持久 eventId 去重。
- AR2b 落地前，当前 `run_settled` 仍只是实时 canonical frame，不是持久记录。
- 当前 UI 仍由旧 `done/incomplete/error` 驱动；切换到持久 Run 状态是 `spec-run-state-recovery-ui.md` 的明确交付，不提前声称完成。

### 3.3 Spreadsheet

- Python 表格依赖构建期预装，任务运行中不允许模型临时 pip。
- `.xls` 使用 `xlrd` 或受控转换，不再进入 openpyxl。
- v1 使用系统 LibreOffice + 强 preflight；缺失时阻止公式型交付并给安装引导。
- Managed LibreOffice 先做分发 Spike，未通过签名、许可、体积和升级验证前不进入实施范围。
- 任何公式型正式交付都必须由真实计算引擎重算。

### 3.4 完成语义

- 模型文字不是完成证据。
- 新文件先是工作文件；只有通过质量门并复制到不可变 `delivered/` 区域后才是正式附件。
- RunStore 是完成状态唯一写入者；validator 只提供与文件哈希绑定的 CompletionEvidence。
- 合并报表必须检查期间、公司、资产负债、现金和明确的调整抵消断言。

## 4. Contract Sequence

共享合同必须按下列顺序冻结，不能并行修改同一合同文件：

1. `spec-model-routing-v2.md`：ModelConfig 与纯 resolver。
2. `spec-run-contract-v2.md`：Run 状态、TaskContract、CompletionEvidence、AR2a 映射。
3. `spec-spreadsheet-runtime-preflight.md`：SpreadsheetCapability；通过 Run Contract 中的扩展点接入。
4. 其余实现 Spec 只消费上述合同。

合同审查未通过前，只能执行不依赖合同的 Spike，不得启动下游实现。

## 5. Implementation Packages

| ID | 文档 | 状态 | 前置依赖 | 所有权 |
|---|---|---|---|---|
| CR-M1 | `spec-model-routing-v2.md` | **已ship（Batch 0）** · `audit-model-routing-v2.md` | 无 | 模型配置、UI/API、纯 resolver |
| CR-R0 | `spec-run-contract-v2.md` | **Frozen** · `lib/agent/run-contract.ts` · `audit-run-contract-v2.md` | AR2a 已 ship | 共享 Run/Task/Completion 类型 |
| CR-S1 | `spec-spreadsheet-runtime-preflight.md` | **Runtime Core 已ship**；合同接线仍 Blocked · `audit-spreadsheet-runtime-preflight.md` | CR-R0 扩展点 | Python 依赖、能力探测、系统 LO |
| CR-R1 | `spec-run-events-persistence-replay.md` | **Ready for Agent**（CR-R0 Frozen） | CR-R0 | AR2b、run_events、checkpoint、replay |
| CR-Q1 | `spec-deliverable-quality-gate.md` | **Ready for Agent**（CR-R0 Frozen + CR-S1 Core） | CR-R0、CR-S1 | 通用 validator registry、不可变交付 |
| CR-Q2 | `spec-consolidation-workbook-validator.md` | Blocked | CR-Q1 | 合并报表领域 Profile |
| CR-R2 | `spec-run-state-recovery-ui.md` | Blocked | CR-R1 | AR2c + AR4、状态恢复、UI 切换 |
| CR-P1 | `spec-run-scoped-python-capability.md` | Blocked | CR-R1、CR-R2 | Run 级权限、路径边界、TTL |
| CR-X1 | `spike-sdk-segment-control.md` | **Spike 完成：PARTIAL** · `spike-sdk-segment-control-findings.md` | 无 | SDK interrupt/resume/quiesce 可行性 |
| CR-X2 | `spike-managed-libreoffice-distribution.md` | Ready for Agent | 无 | 三平台 LO 分发可行性 |

## 6. Implementation Parallelism

### Batch 0：合同与 Spike

- ~~CR-M1 可以独立实施。~~ **已完成**（`audit-model-routing-v2.md`）。
- CR-R0 只写/评审共享合同，不接 Query Pipeline（下一批优先）。
- ~~CR-X1~~ **已完成（PARTIAL）**；CR-X2 仍可并行验证。
- ~~CR-S1 Runtime Core~~ **已完成**；与 TaskContract 的接线等待 CR-R0 冻结。
- X1 结论：不立无感自动分段；仅允许显式用户 resume 路线（见 findings）。

### Batch 1：基础闭环

- CR-R1 实现持久事件与重放。
- CR-Q1 实现通用文件质量门。
- 两者文件所有权分离；共享 migration 编号按顺序申请。

### Batch 2：用户体验与领域质量

- CR-R2 实现断线恢复和权威完成态 UI。
- CR-P1 基于持久 Run 实现任务级权限。
- CR-Q2 实现合并报表 Profile。

### Batch 3：集成门

不再新增一份大实施 Spec。由本路线图的 Definition of Done 驱动集成审计，并记录在 `audit-complex-task-reliability-integration.md`。

## 7. Ownership Rules

- CR-M1 不修改 Query Pipeline、主 Adapter、RunStore 或 trace；只提供纯 resolver 和独立消费者。
- CR-R0/R1/R2 独占 Run 状态、事件、checkpoint、Query Pipeline 和 UI 状态迁移。
- CR-S1 独占 Python/LibreOffice probe、inspect、convert、recalc、render。
- CR-Q1 独占 validator registry、deliverable registry 和 CompletionEvidence；不修改 Run 终态。
- CR-Q2 只注册领域 Profile，不复制通用文件校验和重算实现。
- CR-P1 只消费 runId/status，不建立第二套 session/run store。
- 共享文件冲突由上游合同 owner 合并，下游代理不自行建立兼容垫片。

## 8. First Release Scope

第一期必须完成：

1. 模型路由 v2，复杂任务真实使用 `mainModel`。
2. `.xls` 和 Spreadsheet capability preflight。
3. AR2b 持久事件；SSE 断开不再等价于用户停止。
4. 通用交付质量门与不可变 delivered 副本。
5. 合并报表 validator 能拦截都森样本中的旧期间、公司占位符、资产负债不平和现金不平。
6. UI 不再把旧 `done` 帧单独当作有文件任务成功证据。

第一期不要求：

- Managed LibreOffice 分发。
- 自动 segment 续接。
- 完整 OS 级 Python 沙箱。
- 三平台托管 LO release。

这些功能必须在对应 Spike 给出正面证据后另立实施 Spec。

## 9. Definition of Done

1. 都森级 fixture 在单 Run 中产生一份 validated/delivered 工作簿。
2. 错误工作簿不能进入正式附件，模型说“完成”不能绕过质量门。
3. 复杂任务、普通任务、Router、子代理实际模型与槽位语义一致。
4. `.xls` fixture 可读，公式型任务缺 LO 时在执行前明确阻断。
5. SSE 断开后可通过持久事件重建现场；用户 stop 与系统错误可区分。
6. 当前 AR2a `run_settled` 三值与既有 S1-S5 测试保持兼容。
7. 每个功能包通过自身定向测试；共享 CI 在合并批次运行全量测试、typecheck、lint 和 build。
8. 最终集成审计记录各包 commit、migration、真实运行证据与剩余风险。

## 10. Related Documents

- `ROADMAP-agent-runtime.md`
- `spec-agent-event-contract.md`
- `audit-agent-event-contract.md`
- `spec-run-python-session-trust.md`
- `audit-run-python-session-trust.md`
- `audit-complex-task-reliability.md`
