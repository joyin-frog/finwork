# Audit: complex-task-reliability（Spec 设计审查）

> 类型：设计审查（非实施 audit）  
> 审查对象：`docs/spec/spec-complex-task-reliability.md` v1.0（状态：Ready for Agent）  
> 审查日期：2026-07-21  
> 审查范围：问题诊断可信度、与现有代码/AR2a/ROADMAP 对齐、合同可实施性、并行工作包边界  
> 判定：**Needs Revision — 不宜按当前状态直接派多代理开工**

> **后续处置（2026-07-21）**：原大 Spec 已标记 `Superseded / Do Not Implement`，重构为
> `ROADMAP-complex-task-reliability.md`、8 份独立功能 Spec 与 2 份验证 Spike。新文档保留
> AR2a 三值 outcome，将 Managed LibreOffice 和 SDK 自动分段降为 Spike，并重新划分合同顺序
> 与文件所有权。本审计原判定保留，作为拆分依据；新文档需单独评审，不能把本备注视为自动批准。

---

## 1. 一句话结论

问题诊断与现有代码高度对齐，Solution 方向正确；但文档范围过大、与已 ship 的 AR2a 终态词表冲突、合同冻结顺序自相矛盾，且若干高成本决策（Managed LibreOffice 分发等）仍像已拍板。应先修订合同对齐与拆包，再标 Ready。

---

## 2. Spec 主张 vs 代码事实

| Spec 主张 | 代码事实 | 判定 |
|---|---|---|
| 复杂任务未稳定使用推理模型 | `pickAgentModel` / `resolveModelByTier("reasoning")` 将 `complex_workflow` 与「推理」绑到 `subagentModel`；`mainModel` 主要作 SDK/`settings.model` 回退标签 | **属实**；且与 Spec §4.1 槽位表语义倒置 |
| 硬编码厂商模型兜底 | `lib/agent/router.ts`、`lib/agent/conversation-title.ts` 存在 `"claude-haiku-4-5-20251001"` | **属实**；直接违反 Spec 禁止项 |
| 固定 10 分钟切断长任务 | `lib/agent/claude-adapter.ts` 约 600_000 ms timeout | **属实** |
| 一次达到 30 turns | 同文件 `maxTurns: 30` | **属实** |
| 15 次 Python 调用卡住保护 | `lib/agent/hooks/built-in.ts`：`MAX_PY = 15`（另有连续错误/中断上限） | **属实** |
| Agent 依附 SSE；断开即中止 | `app/api/agent/query/route.ts`：`requestSignal` abort 关闭流并连带中止 SDK | **属实**；无服务端持久 Run |
| `finalize_deliverable` 只登记文件名 | `lib/agent/mcp-tools/finalize-deliverable.ts` 写 `.finalized.json`，无存在性/重算/勾稽/哈希门 | **属实** |
| `.xls` / 公式重算非产品能力 | worker 对 `.xls` 走 `openpyxl`；`xlrd` 未接入；LibreOffice recalc 仅 skill 脚本 | **属实** |
| 权限按调用重复确认 | 已有 conversation 级 `session-trust`（可「本次对话不再询问」），进程内、重启丢失；非 Run/任务级、无真实路径沙箱 | **部分属实**：比「每次确认」好，仍达不到 Spec §4.4/§10 |

入口索引：

- 模型：`lib/settings/claude-settings.ts` · `lib/agent/router.ts` · `lib/agent/claude-adapter.ts`
- 生命周期：`app/api/agent/query/route.ts` · `lib/agent/runtime-events.ts`
- 卡住保护：`lib/agent/hooks/built-in.ts`
- 交付：`lib/agent/mcp-tools/finalize-deliverable.ts`
- 权限：`lib/agent/hooks/session-trust.ts`

---

## 3. 做得好的地方

1. **问题链完整**：模型槽位 → Spreadsheet Runtime → 生命周期/预算 → 权限 → 质量门，不是零散功能堆砌。
2. **Non-negotiable 可执行**：完成态由系统判定、禁止 SDK 默认模型、SSE 断开≠abort、假交付关门。
3. **迁移规则意识到现状倒置**：旧 UI 把 `subagentModel` 当推理槽；推荐迁移顺序比「直接改名」务实。
4. **CompletionEvidence + `delivered/` 不可变副本**：正确关掉「校验后再改文件」的 TOCTOU。
5. **预算用 epoch + 可观察进展**：比单纯删除 `MAX_PY=15` 更完整，也呼应「放宽 ≠ 无限跑」。

---

## 4. 阻塞级发现（开工前必须改 Spec）

### B1. 与 AR2a `run_settled` 词表冲突

| | AR2a（已 ship） | 本 Spec |
|---|---|---|
| settled outcome | `completed \| aborted \| error` | `completed \| failed \| canceled` |
| 可恢复态 | 无（或未进合同） | `waiting_user` / `waiting_dependency` / `paused` |
| settled 是否权威落库 | SSE canonical；**不**进 `chat_agent_events` | 「终态权威记录」暗示可重连/审计依赖 |

`aborted` ≠ `canceled`，`error` ≠ `failed`。六个子代理若按本 Spec 直接改词表，会拆掉 `runtime-events` 类型与 S1–S5 测试。

**要求修订**：增补「与 AR2a / ROADMAP 对齐」专节——保留 settled 三值或定义显式映射；细因放 `termination_reason`；明确 `waiting_*`/`paused` **不**发 settled；写清 UI 完成态何时从旧 `done`/`incomplete` 切到持久 Run（见 `audit-agent-event-contract.md`「实现现状校准」）。

### B2. 状态「Ready for Agent」与范围不匹配

六包并行覆盖：模型原子配置、Managed LO 分发、三平台 release、持久 Run、任务沙箱、财务质量门、真实 E2E。这是路线图体量，不是一份可一次批给多代理的实施 spec。

**要求修订**：状态改为 `Needs Revision` 或 `Design Approved / Contracts Pending`；先冻结 2–3 页合同（ModelConfig、Run 状态机、SpreadsheetCapability、CompletionEvidence），再开实施包；WP-F 作 release gate，不与 A–E 同级 Ready。

### B3. 合同冻结顺序自相矛盾

- §6：第一批并行 A、B、C。
- §13.1：A → C → B。

B 的 Capability 要进 C 的 TaskContract，C 又消费 A 的 resolver。真正可并行的是**纯合同草稿**，不是实现接线。

**要求修订**：拆成两张表——「合同序列」与「实现并行面」；禁止 A/B/C 同时改共享类型文件。

### B4. WP-A 所有权边界打架

正文：A 不修改 Query Pipeline / 主 Adapter / trace。  
Test Seams：又要求测 Router/Query stage、Adapter。  
独立消费者（标题/摘要/用量）归 A，又可能与 C 抢共享文件。

**要求修订**：A 只交付纯 `resolveExecutionModel` + settings 迁移/UI/API；pipeline 接线与相关测试一律归 C。

---

## 5. 高风险设计债（应拍板或降级）

| ID | 项 | 风险 | 建议 |
|---|---|---|---|
| H1 | Managed LibreOffice 分发 | 签名、体积、许可、Gatekeeper/Authenticode——接近独立产品线 | v1：系统 LO + 强 preflight；managed LO 单列 WP-B2 |
| H2 | `FW_*` Defined Names 契约 | 模板/模型不产出这些名 → 合法报表被拒 | 写清模板来源、谁注入、失败引导 |
| H3 | 同一会话仅一个未终止主 Run | 改变现有多回合体验 | 明确是否含 waiting/paused；与「继续」/resume 共存规则 |
| H4 | UI 仍信旧 `done` 帧 | 即使服务端门控正确，用户仍可能看见假成功 | DoD 必须含「聊天完成态切换」验收 |
| H5 | §10.4「真实沙箱」 | 仅路径检查而无 OS/worker 隔离 = 空头支票 | v1 写清：规范化路径 + symlink 拒绝；完整沙箱另立包 |
| H6 | 每包强制全量 `npm test` + `audit-<package>.md` | 与项目默认路径及六代理并行冲突 | 定向测试 + 共享 CI；audit 仅 F 或高风险 diff |
| H7 | Segment 自动续接 / quiesce / kill | 依赖 SDK interrupt/resume 控制点；Out of Scope 又写不换 SDK | 引用 AR5-spike / 现有 resume，标出未知控制点 |

---

## 6. 文档内小不一致

1. Problem 写「30 turns」，Goals/WP-C 未点名删除或替换 `claude-adapter` 的 `maxTurns: 30`。
2. §4.3 `canceled/user_stop` vs AR2a `aborted`（见 B1）。
3. §9.5「继续」调 resume、不发文本「继续」——未写与现聊天「用户再发一条」路径的迁移。
4. 迁移后设置页「快速」原子写 `routerModel`+`subagentModel`，与旧「推理=subagent」用户样本的覆盖关系需写清。
5. §17 要求消费 ROADMAP 持久事件/状态机，但本 Spec 未声明如何更新 ROADMAP 状态表（AR2b/AR2c/AR4）。

---

## 7. 与 ROADMAP / 既有 Spec 关系

| 既有文档 | 关系 | 冲突？ |
|---|---|---|
| `ROADMAP-agent-runtime.md` | 本 Spec 把 AR2b/AR2c/AR4 等 P1 能力升为复杂任务的 Non-negotiable | **叠加，非否定**；需同步改 ROADMAP 优先级/状态 |
| `spec-agent-event-contract.md` + `audit-agent-event-contract.md` | settled 语义、UI 仍靠旧帧 | **有词表与权威落库冲突**（B1） |
| `audit-run-python-session-trust.md`（若存在） | conversation 级信任 | 本 Spec 升为 Run 级 capability；需写清替换而非双轨 |

铁律提醒（来自 ROADMAP）：finwork **不拥有** agent loop，Claude SDK 拥有。本 Spec 的 segment 续接、paused quiesce、stop 传播必须落在 SDK 已暴露控制点上，否则先 spike，不立六包并行实施。

---

## 8. 建议修订动作（按优先级）

1. **增补「与 AR2a/ROADMAP 对齐」一节**：outcome 映射、`termination_reason`、waiting/paused 不 settled、UI 完成态切换里程碑。
2. **降低文档状态**；先产出 Contract Spec（类型 + 状态机 + 错误码），再开 A/C。
3. **拆 WP-B**：B1 Capability + 系统 LO preflight；B2 Managed LO 分发（可后置 release gate）。
4. **收窄第一期 DoD**：都森级 fixture 单 Run 可完成 + 假交付被拒 + SSE 断线不杀任务；三平台 packaged LO 进 release，不挡第一期合并。
5. **修正 §6 / §13.1 / WP-A 所有权**；删除或改写「每包独立 audit + 全量 npm test」。
6. **点名改 `maxTurns: 30` 与 10 分钟 timeout** 为 WP-C 验收条目，避免只写更高预算却漏改 adapter。

---

## 9. 审查判定

| 维度 | 判定 |
|---|---|
| 问题诊断 | **通过** — 与代码一致，可作立项依据 |
| Non-negotiable 方向 | **通过** — 方向正确 |
| 与 AR2a 合同兼容 | **不通过** — 词表/权威记录未对齐 |
| 并行工作包可开工性 | **不通过** — 冻结顺序与所有权冲突；范围过大 |
| 「Ready for Agent」标签 | **拒绝** — 改为 Needs Revision 后再批合同包 |

**总判定：Needs Revision。**  
诊断可以信；实施合同还不能信。先修 B1–B4，再考虑派代理。

---

## 10. 附录：审查方法

- 通读 `spec-complex-task-reliability.md` v1.0 全文。
- 对照 `ROADMAP-agent-runtime.md`、`audit-agent-event-contract.md`、`spec-agent-event-contract.md`。
- 用 worktree 内 graphify + 源码核对模型路由、timeout/maxTurns、stuck guard、SSE abort、finalize、xls/LO、session-trust。
- 本文件为设计审查记录，**无代码改动、无红绿测试证据**；实施 audit 应在各 WP ship 后另写。
