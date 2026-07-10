# Audit: finwork-rename-v0.1.6

## Files changed

1. `package.json` — `version` 0.1.5 → 0.1.6
2. `src-tauri/tauri.conf.json` — `productName` "Finance Agent" → "Finwork"；`version` 0.1.5 → 0.1.6；`windows[0].title` "Finance Agent" → "Finwork"
3. `src-tauri/Cargo.toml` — `version` 0.1.2 → 0.1.6；`description` "Finance Agent desktop shell" → "Finwork desktop shell"。`name = "finance-agent"` 未动
4. `app/layout.tsx` — `metadata.title` "Finance Agent" → "Finwork"
5. `lib/runtime/diagnostics.ts` — 第 81 行 "Finance Agent diagnostics export" → "Finwork diagnostics export"
6. `lib/agent/mcp-tools/kingdee-tools.ts` — 第 162 行 `preparedBy: "Finance Agent"` → `"Finwork"`
7. `README.md` — 第 1 行 `# Finance Agent` → `# Finwork`；第 48 行 `# Finance Agent (English)` → `# Finwork (English)`；第 50 行 `[中文](#finance-agent)` → `[中文](#finwork)`
8. `PRIVACY.md` — 第 3 行 "Finance Agent 如何存储..." → "Finwork 如何存储..."
9. `docs/updater-signing.md` — 第 5、82 行 "Finance Agent" → "Finwork"
10. `docs/runbook-signed-release.md` — 第 189–191 行示例文件名 `Finance Agent_x.x.x_*` → `Finwork_x.x.x_*`；第 207、215 行正文替换。示例版本号 1.2.0/1.1.0 未动
11. `.github/workflows/release.yml` — 第 151 行 `releaseName` "Finance Agent" → "Finwork"
12. `docs/architecture.html` — 第 5、192、206 行三处 "Finance Agent" → "Finwork"

## 每个文件改了什么

见上表，均为纯文本替换，与计划 Files touched 表格一一对应。

## 与计划的偏差及原因

无偏差。implementer 报告全部改动与 spec 一致，orchestrator 复核 `git diff --stat` 确认 12 文件、+24/-24 行，与计划范围完全吻合。

补充记录（orchestrator 事后清理）：implementer 为跑测试在本 worktree 建了 `workers/.venv` 符号链接指向主仓库 venv（借鉴 `scripts/link-worktree-node-modules.mjs` 的既有模式），不属于计划内改动，属于本地环境搭建、不应提交。orchestrator 已将其删除，`git status` 确认无残留。implementer 也未按模板要求把 audit 落盘为独立文件（只在回复文本里给了完整内容），orchestrator 据其报告内容代为落盘本文件。

## 测试结果

- `npm run typecheck` — 通过（exit 0）
- `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` — 11 tests，0 failures，0 skipped
- `grep -rn "Finance Agent"` 遍历全部 12 个改动文件 — 无匹配，展示名替换完整
- `identifier`（tauri.conf.json）— 仍是 `com.gyro.financeagent`，未动
- `name`（Cargo.toml）— 仍是 `finance-agent`，未动
- `FINANCE_AGENT_` 前缀计数（paths.ts / lib.rs）— 22 / 11，与改动前基线一致

## 开放风险

- `kingdee-tools.ts` 的 `preparedBy: "Finwork"` 会写入新生成的金蝶凭证草稿"制单人"字段，属预期行为（spec §5 已说明），老凭证不受影响。
- `docs/runbook-signed-release.md` 里的示例版本号（1.2.0、1.1.0）按计划保留未改，不是当前项目版本号，阅读该文档时留意区分。
- 本次改动未触碰 `docs/openhuman-analysis.md`、`docs/spec/spec-ui-refresh.md`、`docs/spec/spec-knowledge-rg-and-role-mode.md` 三个历史存档文档，其中仍保留 "Finance Agent" 字样，属计划内明确排除，非遗漏。
