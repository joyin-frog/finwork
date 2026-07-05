# 修复：确认门在主对话/子代理均不触发（confirm-gate-fix）Spec

> 版本 v1.0 / 2026-07-05
> 状态：~~草案~~ → ~~已批准~~ → **已实施并 ship（真机验证通过）**：主对话触发算薪 → 确认卡弹出 → 确认执行=工具运行 / 取消=deny 无写入，端到端验证；实施审查无阻塞、AC-X2/G4d 绿。
> 依赖：`spec-confirm-gate-card.md`（F2 确认卡，已 ship——卡片本身正确，但上游门不触发，故从未渲染过）
> 严重性：**红线级**。高风险财务动作（算薪 `calculate_payroll_batch`、确认薪资期间 `confirm_payroll_period`、导金蝶 `export_kingdee_draft`）当前在主对话里**无需人确认即执行**。

## 根因（已实证 + SDK 源码双重确认）

- 主 Agent `allowedTools = ALLOWED_TOOLS = TOOL_REGISTRY 全部工具名`（`lib/agent/tools/registry.ts:73`, `lib/agent/claude-adapter.ts:212`）。
- `@anthropic-ai/claude-agent-sdk` 文档（`node_modules/.../sdk.d.ts:1294`）：`allowedTools` = "auto-allowed **without prompting**"。在其中的工具，CLI 直接放行，**不发 `can_use_tool` 控制请求**，SDK 的 `canUseTool` 回调**永不被调用**。
- 确认门钩子 `createRiskConfirmHook` 挂在 `canUseTool → runBeforeHooks(hookChain)` 里（`claude-adapter.ts:237/243-255`）。canUseTool 不触发 → **整条 before-hook 链不执行 → 确认门永不弹**。
- **实证**：在 `canUseTool` 开头加 `log.info("DIAG canUseTool", …)`，真机跑一次算薪 + 三次 `query_payroll_status`，日志里 **DIAG 一次都没出现**；`calculate_payroll_batch` 直接执行出结果、无确认卡。
- **修复实证**：把高风险工具从 `allowedTools` 移除后，真机再跑算薪，**确认卡如期弹出**（标题「操作确认」+ 动作摘要 + 后果 `RISK_IMPACT_NOTES` + 「取消/确认执行」两按钮），点「取消」→ 工具被 deny、草稿未写入。**修法方向已验证有效。**
- 与本地网关（`127.0.0.1:8317`/`gpt-5.4`）无关：canUseTool 是 SDK↔CLI 本地 stdio 决策，先于模型。
- 子代理同构（`subagent-runner.ts` 的 allowedTools 经 `resolveRoleAllowedTools` 也含高风险工具）→ 子代理确认门**同样从未生效**（注释假设的 deny 路径依赖 canUseTool 被调到）。

## 0. 目标与非目标

**目标**：让确认门对**必须人确认的工具**真正触发——把这些工具从 `allowedTools` 移除，使其经 `canUseTool → risk-confirm hook`。范围 = **高风险财务工具 + always-confirm 工具**。主 Agent 与子代理因共用 `ALLOWED_TOOLS` 一并修复。

**必须人确认的工具（本次纳入）**：
- 高风险**财务**工具（`riskLevel:"high"` 且 `category:"finance"`）：`mcp__finance_worker__calculate_payroll_batch`、`mcp__finance_worker__confirm_payroll_period`、`mcp__kingdee_worker__export_kingdee_draft`。
- always-confirm 工具（`built-in.ts` 的 `ALWAYS_CONFIRM_TOOLS`）：`mcp__finance_worker__remember_convention`、`mcp__finance_worker__update_company_profile`。

**非目标（本期不做，另行处理）**：
- ❌ **`Bash`**（`riskLevel:"high"` 但 `category:"builtin"`）：它是"应被 deny"（`createUnwiredToolHook`）而非"应确认"的工具，且 `tests/skill-xlsx.test.ts` AC-X2 断言 `ALLOWED_TOOLS.includes("Bash")`。本次**不动 Bash**（保留在 allowedTools，AC-X2 不破），把"Bash 未经门直接可执行"列为**独立后续**（见 §5 遗留）。
- ❌ **整条 before-hook 链的其它休眠钩子**：同一 allowlist 短路使 `read-guard`/`stuck-guard`/`path-safety`/`unwired(Bash)` 对被 allowlist 的工具也不触发。本次只修**确认门红线**，其余休眠钩子列为后续调查（§5）。
- ❌ 不改确认卡 UI（F2 已对）、不改 hook 逻辑、不改 canUseTool 结构、不改 permissionMode。
- ❌ 不把全部工具移出 allowedTools（那会让每个工具都过 IPC + 唤醒所有休眠钩子，回归面过大）。

## 1. 成功标准

- [ ] **确认门对红线工具触发**：`ALLOWED_TOOLS` **不含**上述 3 个高风险财务工具与 2 个 always-confirm 工具；**仍含** `Bash`、`Write`、`run_python`、`query_payroll_status`、`diff_payroll_period` 等非确认工具。验证：纯函数单测断言集合成员。
- [ ] **无漂移守卫**：任何 `riskLevel==="high" && category==="finance"` 的工具、以及 `ALWAYS_CONFIRM_TOOLS` 里的每个名字，都**不在** `ALLOWED_TOOLS`——将来新增高风险财务工具/always-confirm 工具时若忘了排除，此测试红。验证：单测遍历 TOOL_REGISTRY + 导入 `ALWAYS_CONFIRM_TOOLS` 断言。
- [ ] **子代理不回归**：`resolveRoleAllowedTools` 结果仍 ⊆ `ALLOWED_TOOLS`（`role-registry.test` G4d 继续绿）；高风险工具从子代理 allowedTools 落出后，子代理调用它们会经 canUseTool（无 resolver）→ deny（既有设计）。验证：G4d + 一条断言 payroll-officer 的 resolved tools 不再含 calculate_payroll_batch。
- [ ] **AC-X2 不破**：`tests/skill-xlsx.test.ts` 仍绿（Bash/Write 仍在 ALLOWED_TOOLS）。
- [ ] **真机验证（交付硬门槛，非单测）**：起 dev server，主对话触发 `calculate_payroll_batch` → **确认卡弹出**（两按钮、后果文案）；点「确认执行」→ 工具执行；另跑一次点「取消」→ 工具 deny、无草稿写入。截图/日志留证。
- [ ] 全套测试绿；typecheck 过。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/tools/registry.ts` | 修改 | `ALLOWED_TOOLS` 改为排除"确认门要拦的工具"：`(riskLevel==="high" && category==="finance")` 或名字 ∈ always-confirm 集。保留既有注释意图（高风险经确认门兜底）——现在真的兜得住。 |
| `lib/agent/hooks/built-in.ts` | 修改 | `export` 现有的 `ALWAYS_CONFIRM_TOOLS`（当前是模块私有 const），供 registry 排除与测试无漂移守卫引用，单一真源、防两处不同步。 |
| `tests/confirm-gate-fix.test.ts` | 新增 | ①成员断言（红线工具不在、非确认工具在）；②无漂移守卫（high-finance + ALWAYS_CONFIRM 全部被排除）；③子代理 resolved tools 不含高风险。导出 `confirmGateFixTestPromise`。 |
| `tests/all.test.ts` | 修改 | 接入 `confirmGateFixTestPromise`。 |

> ⚠ 避免循环依赖：`built-in.ts` 已依赖 `registry.ts`（`getToolRiskLevel`）。故**由 `built-in.ts` 导出 `ALWAYS_CONFIRM_TOOLS`**，`registry.ts` **不要** import built-in（会成环）。registry 的排除对 always-confirm 用**内联硬编码的两个全名**（加注释指向 `built-in.ALWAYS_CONFIRM_TOOLS`），由测试②的无漂移守卫保证两者一致。

## 3. 实施步骤

1. `built-in.ts`：把 `const ALWAYS_CONFIRM_TOOLS = new Set([...])` 改成 `export const ALWAYS_CONFIRM_TOOLS = new Set([...])`（仅加 export，内容不变）。
2. `registry.ts`：
   ```ts
   // 确认门要拦截的工具：必须移出 allowedTools，否则 SDK 自动放行、canUseTool 不触发、确认门死。
   // always-confirm 两名与 built-in.ALWAYS_CONFIRM_TOOLS 同步（confirm-gate-fix.test 守无漂移）。
   const CONFIRM_REQUIRED_TOOL_NAMES = new Set<string>([
     "mcp__finance_worker__remember_convention",
     "mcp__finance_worker__update_company_profile",
   ]);
   export const ALLOWED_TOOLS: string[] = TOOL_REGISTRY
     .filter((t) => !((t.riskLevel === "high" && t.category === "finance") || CONFIRM_REQUIRED_TOOL_NAMES.has(t.name)))
     .map((t) => t.name);
   ```
   （`Bash` 是 builtin，不被 `category==="finance"` 命中 → 仍在 allowedTools，AC-X2 不破。）
3. `tests/confirm-gate-fix.test.ts` + 接入 `all.test.ts`（见 §4）。
4. **真机验证**：见 §4 末。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npm run typecheck
```
- 新增测试（`tests/confirm-gate-fix.test.ts`，仿 `tests/ask-user-multi.test.ts` 纯逻辑 + 导入断言）：
  1. `["mcp__finance_worker__calculate_payroll_batch","mcp__finance_worker__confirm_payroll_period","mcp__kingdee_worker__export_kingdee_draft","mcp__finance_worker__remember_convention","mcp__finance_worker__update_company_profile"]` 每个都 **不在** `ALLOWED_TOOLS`。
  2. `ALLOWED_TOOLS` **仍含** `Bash`、`Write`、`mcp__finance_worker__run_python`、`mcp__finance_worker__query_payroll_status`、`mcp__finance_worker__diff_payroll_period`。
  3. 无漂移：`TOOL_REGISTRY.filter(t=>t.riskLevel==="high"&&t.category==="finance")` 每个名字不在 ALLOWED_TOOLS；`[...ALWAYS_CONFIRM_TOOLS]`（从 built-in 导入）每个不在 ALLOWED_TOOLS。
  4. 子代理：`resolveRoleAllowedTools("payroll-officer")` 不含 `mcp__finance_worker__calculate_payroll_batch`。
- 回归必看：`tests/role-registry.test.ts`（G4d）、`tests/skill-xlsx.test.ts`（AC-X2）继续绿。
- **真机验证（硬门槛）**：`preview_start` → 主对话发"用 calculate_payroll_batch 算某人某月工资" → 确认**弹出确认卡**（两按钮）；一次点确认（执行）、一次点取消（deny、无写入）→ 截图/日志留证。CLI 起不动则明确交回人工执行本步并说明。

## 5. 风险与开放问题（部分需计划审查裁决）

- **【留给计划审查】Bash 是否本次一并处理**：`Bash` 高风险但设计上应被 `createUnwiredToolHook` deny，当前因 allowlist 短路而**可直接执行**（安全隐患）。本 spec 暂不动 Bash（避免 AC-X2 冲突与范围扩大）。审查者请裁决：本次是否把 Bash 也移出 allowedTools（则需核实 skill 脚本是否真需 Bash、并改 AC-X2），还是列为独立 spec。**建议独立处理**，本次先合红线（财务确认门）。
- **【严重 · 后续】休眠钩子面**：同一 allowlist 短路使 `read-guard`/`stuck-guard`/`path-safety`/`Bash-unwired` 对被 allowlist 的工具也不触发。本次只激活确认门所需工具，其余休眠钩子**未修复**，需单独调查其真实影响面（例如 run_python 的 stuck-guard 节流失效）。列入 follow-up，不在本期。
- **子代理行为变化**：修复后子代理调用高风险工具会被 deny（此前会静默执行）。这是**恢复设计意图**，但属行为变化——子代理若曾"越权"跑高风险工具，现在会停在"待人确认"，主 Agent 应据结果在主对话经确认卡执行（这正是功能 3「一键接管」要收口的场景）。
- **性能**：被移出 allowlist 的工具每次调用多一次本地 stdio IPC + hookChain，毫秒级，无实质影响。
- **真机不可省**：本修复的正确性依赖 SDK 运行时行为，单测只能验集合成员；**必须真机确认确认卡真的弹**（我已在诊断中验证过修法方向有效，实施后需对最终代码再验一次）。

---

## 附录：audit（`docs/spec/audit-confirm-gate-fix.md`）
Files changed（对照 §2）→ §1 逐条核对（含真机验证结果/截图/日志）→ 测试/typecheck 输出 → Bash 与休眠钩子后续项确认 → 偏离/遗留/风险。
