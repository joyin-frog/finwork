# Finwork 改名 + 0.1.6 升版 Spec

> 版本 v1.0 / 2026-07-10
> 状态：草案
> 依赖：无
> 架构事实：
> - `package.json` 的 `name` 字段早已是 `"finwork"`；本次要改的是**展示名**（用户看到的产品名，目前仍是 "Finance Agent"），不是包名。
> - `src-tauri/tauri.conf.json` 的 `identifier`（`com.gyro.financeagent`）是 macOS/Windows 安装路径与 Keychain 的锚点；`lib/runtime/paths.ts` 和 `src-tauri/src/lib.rs` 里写死的 `finance-agent` 子目录名/数据库文件名是老用户本地数据（DB、日志、设置）的路径锚点；`FINANCE_AGENT_` 环境变量前缀是运行时协议。这三类**内部标识符**改了会导致老用户升级后数据"丢失"或 Keychain 项孤立，本次**明确不动**。
> - `src-tauri/Cargo.toml` 的 `[package] name = "finance-agent"` 同理不动（影响二进制名和 `Cargo.lock`），但 `description` 字段是纯文本描述，可以改。

## 0. 目标与非目标

**目标**：把用户可见的产品展示名从 "Finance Agent" 统一改成 "Finwork"，并把版本号从当前不一致的 0.1.5/0.1.2 统一升到 0.1.6。

**非目标（本期不做，已知并接受）**：
- 不改 `src-tauri/tauri.conf.json` 的 `identifier`（`com.gyro.financeagent`）。
- 不改 `lib/runtime/paths.ts`、`src-tauri/src/lib.rs` 里写死的应用数据目录名 `finance-agent` 及数据库文件名 `finance-agent.db` / 备份文件名前缀。
- 不改 `FINANCE_AGENT_*` 环境变量前缀（`lib/runtime/paths.ts`、`src-tauri/src/lib.rs`、`workers/finance_worker.py`、`scripts/`、`playwright.config.ts`、`e2e/` 等 30+ 处）。
- 不改 `src-tauri/Cargo.toml` 的 `[package] name = "finance-agent"`（Cargo 包名/二进制名）。
- 不改 `lib/agent/claude-adapter.ts:163`、`lib/agent/subagent-runner.ts:169` 里的 `CLAUDE_AGENT_SDK_CLIENT_APP: "finance-agent/0.1.0"`（SDK client 标识，固定字符串，不跟随应用版本）。
- 不改历史/存档类文档：`docs/openhuman-analysis.md`（第三方架构研究笔记）、`docs/spec/spec-ui-refresh.md`、`docs/spec/spec-knowledge-rg-and-role-mode.md`（已实施的历史 spec，是当时状态的存档，不追溯改名）。这些文档里提到 "Finance Agent" 是历史记录，不是当前对用户展示的文案。

## 1. 成功标准

- [ ] `grep -rn "Finance Agent" src-tauri/tauri.conf.json src-tauri/Cargo.toml app/layout.tsx lib/runtime/diagnostics.ts lib/agent/mcp-tools/kingdee-tools.ts README.md PRIVACY.md docs/updater-signing.md docs/runbook-signed-release.md .github/workflows/release.yml docs/architecture.html` 无匹配（全部替换为 Finwork）。
- [ ] `grep -n "identifier\|finance-agent" src-tauri/tauri.conf.json src-tauri/Cargo.toml lib/runtime/paths.ts` 确认 `identifier`、Cargo `name`、数据目录名/数据库文件名字符串**未被改动**。
- [ ] `grep -rn "FINANCE_AGENT_" lib/runtime/paths.ts src-tauri/src/lib.rs | wc -l` 改动前后行数一致（前缀未被误改）。
- [ ] `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处 version 字段均为 `0.1.6`。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 通过（确认改动没有破坏依赖 `diagnostics.ts`/`kingdee-tools.ts` 文案的测试；已确认 `tests/` 和 `e2e/` 中没有对 "Finance Agent" 字符串的硬编码断言）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `package.json` | 修改 | `"version": "0.1.5"` → `"0.1.6"`（第 3 行） |
| `src-tauri/tauri.conf.json` | 修改 | `productName`（第 3 行）"Finance Agent"→"Finwork"；`version`（第 4 行）"0.1.5"→"0.1.6"；`windows[0].title`（第 24 行）"Finance Agent"→"Finwork" |
| `src-tauri/Cargo.toml` | 修改 | `version`（第 3 行）"0.1.2"→"0.1.6"；`description`（第 4 行）"Finance Agent desktop shell"→"Finwork desktop shell"。**`name`（第 2 行）不动** |
| `app/layout.tsx` | 修改 | `metadata.title`（第 43 行）"Finance Agent"→"Finwork" |
| `lib/runtime/diagnostics.ts` | 修改 | 第 81 行 "Finance Agent diagnostics export"→"Finwork diagnostics export" |
| `lib/agent/mcp-tools/kingdee-tools.ts` | 修改 | 第 162 行 `preparedBy: "Finance Agent"` → `"Finwork"`（金蝶凭证制单人字段） |
| `README.md` | 修改 | 第 1 行 `# Finance Agent`→`# Finwork`；第 48 行 `# Finance Agent (English)`→`# Finwork (English)`；第 50 行锚点 `[中文](#finance-agent)`→`[中文](#finwork)`（标题改了 GitHub 自动锚点会变，必须同步） |
| `PRIVACY.md` | 修改 | 第 3 行 "Finance Agent 如何存储..."→"Finwork 如何存储..." |
| `docs/updater-signing.md` | 修改 | 第 5 行、第 82 行 "Finance Agent"→"Finwork" |
| `docs/runbook-signed-release.md` | 修改 | 第 189–191 行示例安装包文件名前缀 `Finance Agent_x.x.x_*` → `Finwork_x.x.x_*`（跟随 `productName` 改变后 Tauri 打包实际产出的文件名）；第 207、215 行正文 "Finance Agent"→"Finwork" |
| `.github/workflows/release.yml` | 修改 | 第 151 行 `releaseName: "Finance Agent ${{ github.ref_name }}"` → `"Finwork ${{ github.ref_name }}"`（GitHub Release 页面标题，用户下载时直接看到，漏改会让改名目标白做） |
| `docs/architecture.html` | 修改 | 第 5 行 `<title>Finance Agent · Architecture</title>`、第 192 行 `<h1>Finance Agent · 系统架构</h1>`、第 206 行 `aria-label="Finance Agent architecture"` 三处均改为 Finwork。该文件是活跃维护的架构文档（非历史存档，今日刚被另一 spec 编辑过），不适用"历史文档不追溯"的排除理由 |

此列表限定 implementer 的写权限。实施中若发现列表外文件也硬编码了 "Finance Agent" 展示名（而非上面非目标里排除的内部标识符），应停下并向 orchestrator 报告，不要自行决定是否改。

## 3. 实施步骤

1. `package.json:3` — version 改为 `0.1.6`。
2. `src-tauri/tauri.conf.json:3,4,24` — 三处按上表改。
3. `src-tauri/Cargo.toml:3,4` — version 和 description 按上表改，第 2 行 `name = "finance-agent"` 保持原样不动。
4. `app/layout.tsx:43` — title 改为 `"Finwork"`。
5. `lib/runtime/diagnostics.ts:81` — 字符串改为 `"Finwork diagnostics export"`。
6. `lib/agent/mcp-tools/kingdee-tools.ts:162` — `preparedBy: "Finwork"`。
7. `README.md:1,48,50` — 两处标题 + 锚点链接同步改（锚点必须和新标题的 GitHub slug 一致，即全小写、空格转连字符：`finwork`）。
8. `PRIVACY.md:3` — 替换。
9. `docs/updater-signing.md:5,82` — 替换。
10. `docs/runbook-signed-release.md:189-191,207,215` — 替换，注意第 189-191 行是示例文件名（`Finance Agent_1.2.0_aarch64.dmg` 这类），改成 `Finwork_1.2.0_aarch64.dmg` 格式，版本号部分保持原文档里的示例版本（1.2.0/1.1.0，这些是操作指南里的示例版本号，不是当前项目版本，不要误改成 0.1.6）。
11. `.github/workflows/release.yml:151` — `releaseName: "Finance Agent ${{ github.ref_name }}"` → `"Finwork ${{ github.ref_name }}"`。
12. `docs/architecture.html:5,192,206` — 三处 "Finance Agent" 替换为 "Finwork"。
13. 全部改完后跑第 4 节的验证命令。

**注意**：只做字符串替换，不要顺手改动这些文件里其他内容（格式、其他文案、其他版本号示例等）。

## 4. 测试与验证方式

```bash
# 无需 venv/mock 环境变量，纯文本改动 + 前端 metadata 改动
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

# 验证展示名替换完整且内部标识符未被误改：
grep -rn "Finance Agent" src-tauri/tauri.conf.json src-tauri/Cargo.toml app/layout.tsx lib/runtime/diagnostics.ts lib/agent/mcp-tools/kingdee-tools.ts README.md PRIVACY.md docs/updater-signing.md docs/runbook-signed-release.md .github/workflows/release.yml docs/architecture.html
# 期望：无输出

grep -n "identifier" src-tauri/tauri.conf.json
# 期望：仍是 "com.gyro.financeagent"

grep -n "^name" src-tauri/Cargo.toml
# 期望：仍是 name = "finance-agent"

grep -c "FINANCE_AGENT_" lib/runtime/paths.ts src-tauri/src/lib.rs
# 期望：改动前后计数一致（可在改动前后各跑一次比对，或改动前记录基线）
```

- 不需要跑 `npm run test:e2e`（本次改动不涉及运行时行为，只涉及展示文案和版本号，e2e 已确认没有对 "Finance Agent" 字符串的断言）。
- 不需要跑 `tauri:build`（打包验证成本高，本次只是配置文本改动，line-level diff 审查即可确认正确性）。

## 5. 风险与开放问题

- `kingdee-tools.ts:162` 的 `preparedBy` 字段会写入金蝶凭证草稿的"制单人"字段，是业务数据的一部分不是纯 UI 展示，改动后新生成的凭证会带 "Finwork" 字样，属于预期行为（老凭证不受影响，因为是生成时写入的静态字符串）。
- `docs/runbook-signed-release.md` 里的示例版本号（1.2.0、1.1.0）是操作指南里演示用的版本号，与本次要升级到的 0.1.6 无关，implementer 容易搞混，已在实施步骤里特别注明不要误改。
- Cargo.toml 的 version 字段（0.1.2）此前就与 package.json/tauri.conf.json（0.1.5）不一致，本次一并拉齐到 0.1.6，这是顺手修复不一致，不是范围蔓延——因为它就是"版本号统一"这个目标的一部分。
