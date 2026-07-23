# Audit：CR-R2 持久 Run 状态、断线恢复与权威 UI

> 对应 Spec：`spec-run-state-recovery-ui.md`  
> 日期：2026-07-22  
> 结论：**Partial Ship（核心体验）** — 可宣称 disconnect≠stop、权威完成态与附件质量展示；显式 resume / 断线后重订 SSE 未做完。

## 已落地

1. **生命周期解耦**
   - `lib/agent/run-abort-registry.ts`：按 runId 登记 AbortController。
   - `POST /api/agent/query` 流式路径：`request.signal` 仅关 SSE；Run 用独立 abort。
   - `POST /api/agent/runs/:runId/stop`：用户停止唯一入口（state_changed → settled(aborted) → abort live）。
   - 客户端 `stopTurn` 先调 stop API，再关本地订阅。

2. **CompletionGate 收口**
   - `lib/agent/completion-gate-settle.ts`：有 requiredDeliverables 时，无通过证据不得 settle `completed`。
   - 质量状态写回 `agent_runs.quality_status`。

3. **v1 预算**
   - 删除 `MAX_PY=15`；连续同错 ≥5 才 stuck（`createStuckGuardHook`）。
   - `runBudgetForTier`：fast 50 turns / 20m；reasoning 80 / 60m。

4. **孤儿 Run**
   - 进程内首次建 Run 时 `pauseOrphanRunsOnBoot` → `paused/process_crash`。

5. **UI**
   - `RunStatusBanner` + `useRunStatus`（GET run + deliverables）。
   - `AttachmentQualityBadge` 挂在 `OpenableFileRow`。
   - `canShowFileTaskSuccess`：旧 done 无质量通过证据时不宣称文件任务成功。
   - `GET /api/agent/runs/:runId/deliverables`。

## 明确未做（后续）

- `POST .../resume` 与「继续」按钮改走 resume（仍可发用户消息「继续」开新回合）。
- 断线后客户端按 `lastEventId` 重订事件流（当前重进对话依赖落库消息 + 拉 Run 快照）。
- idle timeout / budget epoch / quiesce 杀子进程的完整 RunManager。
- 自动 segment（X1 PARTIAL 否决）。

## 测试

- `tests/hooks-guard.test.ts`（阈值 5）
- `tests/run-state-recovery-ui.test.ts`（60 次成功不 stuck；同错 5）
- `tests/run-budget-status-abort.test.ts`
- **回归修复（2026-07-22）**：`deriveTaskContractForTurn` 在无表格附件时不再因 `complex_workflow` 强加 workbook（否则 mock/router fallback 会把纯文本 SSE 标成 incomplete）。
- **Mock 全量**：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → exit 0
- **Live 冒烟**（隔离 `scratchpad/live/appdata-r2`，钥匙串 Key + Finwork `apiUrl`/`MiniMax-M3`）：
  - settings apiKeyConfigured
  - 文本回合 → `completed` + `quality=not_applicable`
  - SSE abort 后 Run 仍完成（非 canceled）
  - 显式 stop → `canceled` + `user_stop`
  - 结果：`scratchpad/live/cr-r2-live-results.json`
- **Live xlsx**（`scratchpad/live/cr-r2-xlsx-live-smoke.mts`，隔离 `appdata-r2-xlsx`）：
  - 确定性 finalize → CompletionGate `passed`（无 LLM）
  - 有 xlsx 不 finalize → `failed` + `incomplete`（拦截假成功）
  - 真模型 + 自动确认 run_python → `completed` + `passed` + `delivered/` 落盘
  - 结果：`scratchpad/live/cr-r2-xlsx-live-results.json`
- **校准**：generic 表格合同 `needsRecalc=false`（无 LO 可交付）；consolidation 仍要求重算
- **UI 接线**：`tests/run-state-ui-wiring.test.ts`（横幅/徽标/stop API）

## 验收对照

| AC | 状态 |
|---|---|
| 切页/断网不终止 Run | ✅ 服务端路径 |
| stop → canceled + aborted + user_stop | ✅ |
| 系统错误 failed + error | ✅（既有 settle） |
| waiting/paused 不发 settled | ⚠️ paused 写库未经 settled；waiting 路径未全接 |
| UI 权威完成态 + CompletionGate | ✅ |
| 替换 10m/30 turns/15 py | ✅ |
| 重启后状态可解释 | ✅ pause orphans |
| 无自动 segment | ✅ |
