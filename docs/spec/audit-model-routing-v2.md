# Audit: CR-M1 模型配置与路由语义 v2

> Spec: `docs/spec/spec-model-routing-v2.md`  
> 日期：2026-07-21  
> 批次：Batch 0（与 CR-S1 / CR-X1 并行）  
> 判定：**定向验收通过**（Query Pipeline 接线留给 CR-R1）

## 产出

| 文件 | 动作 |
|---|---|
| `lib/settings/model-config.ts` | 新增：v2 校验/迁移/resolver/readiness/API 解析 |
| `tests/model-config.test.ts` | 新增 |
| `lib/settings/claude-settings.ts` | 读时迁移、原子三槽写入 |
| `app/api/settings/claude/route.ts` | fast/reasoning → 三槽；400 + 磁盘不变 |
| `app/config/model/model-settings.tsx` / `skill-center.tsx` | 快速/推理 UI；`res.ok` |
| `lib/agent/router.ts` | complex → mainModel；去掉 haiku 硬编码 |
| `lib/agent/conversation-title.ts` / `recap-summary.ts` / `subagent-runner.ts` | resolver |
| `lib/usage/quota.ts` | 按 executionTier 分类 |
| 相关既有测试 | 同步更新 |

主代理合并接线：`app/api/settings/doctor/route.ts`（`modelConfigReady`）、`app/shared/first-run-gate.tsx`（双模型字段）。

## 验证

- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/model-config.test.ts` ✓
- `router-direct` / `usage-quota` / `recap-summary` 等定向测试 ✓（实施代理报告）

## 残留

- Query stage / adapter 仍可能残留 `settings.model` 路径 → **CR-R1**
- Agent 入口完整 `MODEL_CONFIG_INCOMPLETE` 阻断 → doctor 已暴露 readiness，入口闸门可在 R1/R2 收紧
