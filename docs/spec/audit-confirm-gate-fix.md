# audit: confirm-gate-fix

> 实施者：claude-sonnet-4-6 / 2026-07-05
> 对应 spec：docs/spec/spec-confirm-gate-fix.md v1.0（状态：已批准）

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `lib/agent/hooks/built-in.ts` | 修改 | `ALWAYS_CONFIRM_TOOLS` 加 `export`，内容不变 |
| `lib/agent/tools/registry.ts` | 修改 | 新增 `CONFIRM_REQUIRED_TOOL_NAMES`；`ALLOWED_TOOLS` 改为过滤排除高风险财务工具与 always-confirm 工具 |
| `tests/confirm-gate-fix.test.ts` | 新增 | CGF-1～CGF-4 四项断言（成员排除、成员保留、漂移守卫交叉校验、子代理路径） |
| `tests/all.test.ts` | 修改 | 接入 `confirmGateFixTestPromise`（在 `payroll-diff` 前） |

仅改动 spec §2 Files touched 所列 4 个文件，无额外改动。

---

## §1 成功标准逐条核对

### SC-1：确认门对红线工具触发（ALLOWED_TOOLS 不含指定工具）

验证命令：
```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/confirm-gate-fix.test.ts
```
输出：
```
confirm-gate-fix: 5 tools excluded / 5 non-confirm tools intact / 3 high-finance drift guard / 2 always-confirm drift guard / subagent path ✓
```

- `mcp__finance_worker__calculate_payroll_batch` — 不在 ALLOWED_TOOLS（CGF-1 通过）
- `mcp__finance_worker__confirm_payroll_period` — 不在 ALLOWED_TOOLS（CGF-1 通过）
- `mcp__kingdee_worker__export_kingdee_draft` — 不在 ALLOWED_TOOLS（CGF-1 通过）
- `mcp__finance_worker__remember_convention` — 不在 ALLOWED_TOOLS（CGF-1 通过）
- `mcp__finance_worker__update_company_profile` — 不在 ALLOWED_TOOLS（CGF-1 通过）
- `Bash`、`Write`、`mcp__finance_worker__run_python`、`mcp__finance_worker__query_payroll_status`、`mcp__finance_worker__diff_payroll_period` — 仍在 ALLOWED_TOOLS（CGF-2 通过）

**结论：通过**

### SC-2：无漂移守卫

CGF-3a：TOOL_REGISTRY 中全部 3 个 `riskLevel==="high" && category==="finance"` 工具均不在 ALLOWED_TOOLS。  
CGF-3b：`built-in.ALWAYS_CONFIRM_TOOLS` 中全部 2 个成员均不在 ALLOWED_TOOLS（交叉一致性：内联名单与真源同步）。

**结论：通过**

### SC-3：子代理不回归

- `resolveRoleAllowedTools("payroll-officer")` 不含 `mcp__finance_worker__calculate_payroll_batch`（CGF-4 通过）
- G4d 守卫（role-registry.test.ts）仍绿：`resolveRoleAllowedTools` 结果 ⊆ ALLOWED_TOOLS，因为该函数末尾有 `.filter((t) => allowedSet.has(t))`，高风险工具从 ALLOWED_TOOLS 落出后自动从所有角色的 resolved tools 中消失。

验证：
```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/role-registry.test.ts
# role-registry: all 7 guards passed ✓
```

**结论：通过**

### SC-4：AC-X2 不破

验证：
```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/skill-xlsx.test.ts
# skill-xlsx: all checks passed ✓
```

`Bash` 是 `category: "builtin"`，不被 `category==="finance"` 条件命中 → 仍在 ALLOWED_TOOLS。AC-X2 断言 `ALLOWED_TOOLS.includes("Bash") && ALLOWED_TOOLS.includes("Write")` 通过。

**结论：通过**

### SC-5：真机验证（硬门槛）

本次由我保证单测与 typecheck 绿；真机弹卡验证由主循环/人工完成（spec §5 明确说明："单测只能验集合成员；必须真机确认确认卡真的弹"）。修法方向在 spec 根因章节已真机验证有效，实施后需对最终代码再验一次。

**本条：待真机验证（交回人工）**

### SC-6：全套测试绿 + typecheck 过

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# pass 9 / fail 0

npm run typecheck
# （无错误，命令成功退出）
```

**结论：通过**

---

## 测试/typecheck 输出摘要

- 全套测试：pass 9 / fail 0 / cancelled 0
- `confirm-gate-fix.test.ts`（直跑）：`confirm-gate-fix: 5 tools excluded / 5 non-confirm tools intact / 3 high-finance drift guard / 2 always-confirm drift guard / subagent path ✓`
- `role-registry.test.ts`（G4d，直跑）：`role-registry: all 7 guards passed ✓`
- `skill-xlsx.test.ts`（AC-X2，直跑）：`skill-xlsx: all checks passed ✓`
- typecheck：无错误，正常退出

---

## 子代理高风险→deny 路径确认

### 路径追踪

1. `subagent-runner.ts:149` — `allowedTools = resolveRoleAllowedTools(task.roleId)`；修复后高风险财务工具不再在此集合中。
2. `subagent-runner.ts:188` — `canUseTool` 钩子。子代理的 `options` 包含 `canUseTool`；SDK 对不在 `allowedTools` 中的工具不自动放行，会调用 `canUseTool`。
3. `subagent-runner.ts:195-200` — `runBeforeHooks(hookChain, { ..., resolveUserQuestion: undefined })`；`resolveUserQuestion` 显式设为 `undefined`。
4. hookChain 中含 `createRiskConfirmHook()`（`subagent-runner.ts:182`）。
5. `built-in.ts:163` — hook 触发：`calculate_payroll_batch` 不在 `ALWAYS_CONFIRM_TOOLS`；`getToolRiskLevel` 返回 `"high"`；返回 `{ action: "confirm", prompt: ... }`。
6. `chain.ts:17-34` — confirm 分支：`ctx.resolveUserQuestion` 为 `undefined` → 直接返回 `{ behavior: "deny", message: ... }`。

**结论：修复后子代理调用高风险财务工具 → canUseTool 被调 → risk-confirm hook 返回 confirm → 无 resolver → deny。路径完整且符合既有设计意图。**

---

## Bash 与休眠钩子后续项确认（本次未动）

- **Bash**：`riskLevel:"high"` 但 `category:"builtin"`，不被 `category==="finance"` 条件命中 → 仍在 ALLOWED_TOOLS → canUseTool 仍不触发 → `createUnwiredToolHook` 的 deny 路径依然休眠（此问题存在于修复前，本次范围不含）。列为独立后续 spec，见 spec §5 遗留。
- **休眠钩子面**：`read-guard`/`stuck-guard`/`path-safety` 对在 ALLOWED_TOOLS 中的工具仍不触发，本次未改。见 spec §5 遗留。

---

## 偏离、遗留、风险

| 项 | 类型 | 说明 |
|---|---|---|
| 无循环依赖 | 符合计划 | `registry.ts` 未 import `built-in`；always-confirm 名单用内联硬编码，由 CGF-3b 漂移守卫保证交叉一致性 |
| G4d 行为变化 | 预期副作用 | `resolveRoleAllowedTools` 末尾已有 `.filter((t) => allowedSet.has(t))`；高风险工具落出 ALLOWED_TOOLS 后自动从所有角色 resolved tools 消失，G4d 守卫仍通过 |
| Bash 未修复 | 遗留（独立 spec） | 见 spec §5；本次不动，AC-X2 不破 |
| 真机验证 | 待人工 | spec 明确此项由主循环/人工完成，实施者不需 preview |
