# Audit: CR-R1 Run 事件持久化与重放 + 模型接线

> Spec: `docs/spec/spec-run-events-persistence-replay.md`  
> 日期：2026-07-22  
> 判定：**定向验收通过**（未做 R2 RunManager / SSE 断线续跑）

## 产出

| 文件 | 动作 |
|---|---|
| `lib/db/migrations.ts` | **v21** `agent_runs` + `run_events`（settled 唯一索引）；链上 v22 由 Q1 并行占用 |
| `lib/db/run-store.ts` | 新增：create / append durable / checkpoint upsert / settled 幂等 / replay cursor |
| `lib/agent/run-event-persistence.ts` | 发射路径适配：durable 落库 + checkpoint 触发 |
| `lib/agent/resolve-run-model.ts` | Router 后只调 `resolveExecutionModel`（含 fallback 三分支） |
| `app/api/agent/query/route.ts` | 创建 Run、persist envelope、`run_started`/`settle` 落库；保留旧 done/incomplete/error |
| `app/api/agent/runs/[runId]/route.ts` | GET Run 快照 |
| `app/api/agent/runs/[runId]/events/route.ts` | GET `afterEventId` 增量重放 |
| `lib/observability/trace-write.ts` / `lib/usage/store.ts` | usage 写入/读取 `executionTier` |
| `lib/agent/claude-adapter.ts` | 去掉 `settings.model` 回落 |
| `tests/run-events-persistence.test.ts` | store / migration / replay / settled / delta / complex→main |
| `tests/fixtures/golden-schema.json` | 同步 v21（及并行 v22）表 |

## 验证

- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/run-events-persistence.test.ts`
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/runtime-events.test.ts`
- （全量定向）同上环境跑上述 + `run-contract` / `model-config` 相关用例

## 明确未做（符合 Out of Scope）

- RunManager / SSE 断开后继续执行（CR-R2）
- UI 权威完成态切换
- deliverable / validator（CR-Q1）
- 修改 AR2a `run_settled.outcome` union

## 迁移编号

- **本包：v21**（三查时链尾为 20）
- v22 已被并行 Q1 占用；本包未改 v22 DDL
