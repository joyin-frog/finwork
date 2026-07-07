# Windows 运行时防线收口（WP7a：编码防线统一 + 守护 CI 守护者 + tar 兜底）Spec

> 版本 v1.1 / 2026-07-06（v1.0 计划审查 fix first，B1-B3/N1-N4 已修订，待限定复审）
> 状态：**已实施并通过审查（ship）**。前任 implementer 额度中断、收尾者核对补全（audit 首节有说明）；实施审查零阻塞（12 调用点手术式核对通过；非阻塞：all.test.ts 双注册系 WP2a 归属误判、run-python 注释迁移至 python-env 头部、tar 测试经注入不直测探针为 spec 已接受取舍）。
> 依赖：无。
> **摸底修正**：防线大半已存在——ci-verify.yml:69 有 `windows_smoke` job（build→prepare-tauri→cargo check→windows-smoke.mjs，扫 6 条致命签名串）；release.yml 三平台矩阵真打包；prepare-tauri.mjs 有 claude CLI 缺失硬 throw + node:sqlite 探测硬 throw；lib.rs 有 CREATE_NO_WINDOW/Job Object/动态端口；run-python.ts:66-69 有 PYTHONUTF8=1 GBK 防线。历史五大 Windows 翻车（standalone 漏 chunk、Scripts/python.exe 误判、GBK stdio、黑控制台窗、残留进程占端口）均已修并留有注释。本 spec 是**收口**：补三个真实缺口。
> 架构事实（v1.1 按 reviewer 逐点核实修正）：python 子进程调用点 12+ 处。**已有编码注入 4 处**：run-python.ts:66-69（另带 OUTPUT_DIR/TRACE_ID/TURN_BEFORE/PATH/HOME/VIRTUAL_ENV 等自有键）、read-document.ts:52、kingdee-tools.ts:582、payroll.ts:417。**无注入 6 处（全是真实漏洞面）**：`lib/knowledge/parsers/index.ts:129,139`（文档解析，中文输出高频）、`lib/domain/reconciliation.ts:140`、`lib/domain/reimbursement.ts:22`、`lib/domain/tax-cumulative.ts:160`、`lib/agent/mcp-tools/finance-tools.ts:121`、`lib/runtime/python-doctor.ts:74`（经可注入 runner 接口）。`lib/runtime/python-installer.ts:161` 用 `execFile("tar",...)` 解压 python-runtime，Windows 10 1803 前无内置 tar，无特判无引导。`tests/ci-workflow.test.ts` 只断言 lint/typecheck/test/golden 存在，**不守护 windows_smoke job**——它被误删 CI 不会红。

## 0. 目标与非目标

**目标**：三个收口——
① **编码防线统一**：新建 `lib/runtime/python-env.ts`（reviewer N1——paths.ts 是纯路径解析不混职责）导出 `pythonSpawnEnv(extra?: Record<string,string|undefined>)`，合并语义 = `{...process.env, PYTHONUTF8:"1", PYTHONIOENCODING:"utf-8", ...extra}`（extra 最后展开、可覆盖，满足 run-python.ts 把 OUTPUT_DIR/TRACE_ID 等自有键经 extra 传入，reviewer B2）；**全部调用点包括已注入的 4 处统一改用 helper**（消除四处手拼的漂移面），python-doctor 的 `defaultRunner` 内部改用 helper（runner 可注入性保留，枚举断言对准 defaultRunner 源码，reviewer B3）；
② **守护 CI 守护者**：ci-workflow.test.ts 补断言——ci-verify.yml 含 `windows_smoke` job 且其步骤含 `windows-smoke.mjs`、release.yml 含 windows-latest 矩阵项；
③ **tar 兜底**：python-installer 调 tar 前探测可用性（`spawnSync("tar","--version")`），不可用时抛出带引导的错误（"Windows 10 1803 以下需手动安装 Python 运行时或升级系统"），不静默失败。

**非目标**：PR CI 加真 tauri build（release 已覆盖，PR 加会拖慢每次 CI，摸底显示 windows_smoke 的 next+prepare+cargo check 已覆盖主要断裂面）；Windows Playwright e2e（成本高收益边际）；引入 node 端 tar 库（依赖纪律——检测+引导足够）；Windows 模拟测试层（大工程，等下一批评估）。

## 1. 成功标准（先红后绿）

- [ ] `lib/runtime/python-env.ts` 导出 `pythonSpawnEnv(extra?)`（合并语义见 §0）；调用点全部改用。**枚举断言的定案实现（reviewer B3）**：测试维护一份调用点文件清单（开工 rg 现场枚举），对每个文件断言源码**正向包含 `pythonSpawnEnv`**——统一律：不传 env 字段（继承父环境）也算不合规，必须显式过 helper，防未来漂移；python-doctor 断言落在 defaultRunner 函数体。helper 自身测试：输出含两个编码键 + extra 覆盖优先级。
- [ ] `tests/ci-workflow.test.ts` 补两条断言（windows_smoke 存在于 ci-verify.yml；release.yml 有 windows）。红态自证（reviewer N3 收紧）：**临时改动仅存在于验证瞬间，跑完立即还原并以 `git diff --stat` 证明 workflows 目录零改动**，输出进 audit，不落 git。
- [ ] python-installer 的 tar 探测：不可用路径抛出含"手动安装/升级系统"引导的中文错误。**测试方案定案（reviewer N2）：经既有 `InstallSteps` 注入接口替换 extract 实现模拟 tar 缺失，不做 PATH 劫持**（execFileAsync 无 env 注入口，劫持脆）。
- [ ] `parsers/index.ts` 两处调用点在①中被覆盖（它们是本 spec 的起因，audit 单独点名确认）。
- [ ] 全量绿 + typecheck + lint；python 脚本零改动（git diff 证明）。

## 2. Files touched

| 文件 | 动作 |
|---|---|
| `lib/runtime/python-env.ts` | 新增：pythonSpawnEnv helper（含 extra 合并） |
| 调用点统一替换 env（10 文件） | 无注入 6 处：`lib/knowledge/parsers/index.ts`（两点）、`lib/domain/reconciliation.ts`、`lib/domain/reimbursement.ts`、`lib/domain/tax-cumulative.ts`、`lib/agent/mcp-tools/finance-tools.ts`、`lib/runtime/python-doctor.ts`（defaultRunner）；已注入 4 处改用 helper 消除手拼：`lib/agent/mcp-tools/run-python.ts`（自有键经 extra 传）、`lib/agent/mcp-tools/read-document.ts`、`lib/agent/mcp-tools/kingdee-tools.ts`、`lib/agent/tools/finance/payroll.ts`；另 `lib/runtime/python-installer.ts`（pip 调用点 + tar 探测） |
| `tests/windows-hardening.test.ts` | 新增：helper 输出/调用点枚举扫描/tar 不可用路径 |
| `tests/ci-workflow.test.ts` | 修改：补 windows_smoke 与 release windows 断言 |
| `tests/all.test.ts` | 修改：注册 |

implementer 开工先 `rg -n "execFileSync\(getPythonPath|spawn\(getPythonPath|execFile\(pythonPath|execFileSync\(pythonPath" lib/ scripts/` 重新枚举全部调用点（以上清单来自 scout，以现场为准；发现清单外调用点一并纳入并记 audit，这不算越界——枚举完整性正是本 spec 主旨）。

## 3. 实施步骤

1. 红测试（helper 不存在红；ci 断言现状应绿——写完先跑确认，再做删字符串红态自证；tar 模拟）。
2. helper + 逐调用点替换（每 3-4 个跑一次 typecheck）。
3. tar 探测与引导错误。
4. 全量验证 + 枚举扫描断言绿。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test && npm run typecheck && npm run lint
```
- mac 上无法真验 GBK 行为——枚举式源码扫描断言是替代防线（保证注入存在），真实回归看 CI windows_smoke。

## 5. 风险与开放问题

- env 统一注入对 mac/Linux 无副作用（PYTHONUTF8 在 UTF-8 系统是幂等的）。
- 调用点替换是机械大面积小改——reviewer 按"每处只改 env 参数"审，发现顺手改动即 fix first。
- 被否决：① PR CI 真 tauri build（时长成本，windows_smoke 已覆盖断裂面）；② node tar 依赖（纪律）；③ 一并做 Windows 模拟测试层（大抽象，无本批事实基础）。
