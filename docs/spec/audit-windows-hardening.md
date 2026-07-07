# Audit: WP7a Windows 运行时防线收口

> 前任 implementer 额度中断，本 audit 由收尾者核对后编写。
> 核对基准：docs/spec/spec-windows-hardening.md v1.1

## Files changed

（前任 implementer 完成 + 收尾者核对，合并后终版清单）

**新增（untracked）：**
- `lib/runtime/python-env.ts` — pythonSpawnEnv helper
- `tests/windows-hardening.test.ts` — WP7a 测试（helper / 枚举扫描 / tar 不可用）

**修改（tracked，相对 HEAD）：**
- `lib/knowledge/parsers/index.ts` — 两处调用点换用 pythonSpawnEnv
- `lib/domain/reconciliation.ts` — 换用 pythonSpawnEnv
- `lib/domain/reimbursement.ts` — 换用 pythonSpawnEnv
- `lib/domain/tax-cumulative.ts` — 换用 pythonSpawnEnv
- `lib/agent/mcp-tools/finance-tools.ts` — 换用 pythonSpawnEnv
- `lib/runtime/python-doctor.ts` — defaultRunner 换用 pythonSpawnEnv
- `lib/agent/mcp-tools/run-python.ts` — 原手拼 env 改经 extra 参数传自有键
- `lib/agent/mcp-tools/read-document.ts` — 换用 pythonSpawnEnv
- `lib/agent/mcp-tools/kingdee-tools.ts` — 换用 pythonSpawnEnv
- `lib/agent/tools/finance/payroll.ts` — 换用 pythonSpawnEnv
- `lib/runtime/python-installer.ts` — pip 调用点换用 pythonSpawnEnv + tar 探测与引导错误
- `tests/ci-workflow.test.ts` — 补 AC7：windows_smoke 与 release windows 断言
- `tests/all.test.ts` — 注册 windowsHardeningTestPromise

## 逐条成功标准核对

### SC1：helper 合并语义与 extra 覆盖优先级

**结果：PASS**

`lib/runtime/python-env.ts` 实现：
```
{ ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...extra }
```
extra 最后展开，可覆盖编码键，可追加自有键。测试：
- `pythonSpawnEnv()` 含两个编码键
- `pythonSpawnEnv({ PYTHONUTF8: "0" })` → PYTHONUTF8 被覆盖为 "0"，PYTHONIOENCODING 不受影响
- `pythonSpawnEnv({ MY_KEY: "hello" })` → 自有键透传
- 继承 process.env.PATH

### SC2：全部调用点改用 pythonSpawnEnv（含枚举扫描断言）

**结果：PASS**

现场 `rg` 枚举结果（收尾者独立复查）：

| 文件 | 行 | 状态 |
|---|---|---|
| `lib/knowledge/parsers/index.ts` | 133, 143 | pythonSpawnEnv 已注入 |
| `lib/domain/reconciliation.ts` | 144 | pythonSpawnEnv 已注入 |
| `lib/domain/reimbursement.ts` | 23 | pythonSpawnEnv 已注入 |
| `lib/domain/tax-cumulative.ts` | 161 | pythonSpawnEnv 已注入 |
| `lib/agent/mcp-tools/finance-tools.ts` | 122 | pythonSpawnEnv 已注入 |
| `lib/runtime/python-doctor.ts` (defaultRunner) | 75 | pythonSpawnEnv 已注入 |
| `lib/agent/mcp-tools/run-python.ts` | 59 | pythonSpawnEnv({...extra}) 消除手拼 |
| `lib/agent/mcp-tools/read-document.ts` | 53 | pythonSpawnEnv 已注入 |
| `lib/agent/mcp-tools/kingdee-tools.ts` | 583 | pythonSpawnEnv 已注入 |
| `lib/agent/tools/finance/payroll.ts` | 418 | pythonSpawnEnv 已注入 |
| `lib/runtime/python-installer.ts` (pip) | 172 | pythonSpawnEnv() 已注入 |

spec 清单 vs 现场枚举：无差异。无发现清单外遗漏调用点。

python-doctor 断言落在 defaultRunner 函数体（源码 line 73-80）：通过。

`parsers/index.ts` 两处（spec 单独点名）：两处均含 `pythonSpawnEnv`，通过。

### SC3：ci-workflow.test.ts 补 AC7 断言

**结果：PASS**

`tests/ci-workflow.test.ts` 含：
- `assert.ok(verify.includes("windows_smoke"), "AC7 FAIL: ci-verify.yml 应包含 windows_smoke job")`
- `assert.ok(verify.includes("windows-smoke.mjs"), "AC7 FAIL: ci-verify.yml 的 windows_smoke 步骤应包含 windows-smoke.mjs")`
- `assert.ok(release.includes("windows-latest"), "AC7 FAIL: release.yml 应包含 windows-latest 矩阵项")`

`ci-verify.yml` 实际含 `windows_smoke`（line 69）和 `windows-smoke.mjs`（line 103）。
`release.yml` 含 `windows-latest`（line 43）。三条断言均绿。

### SC4：红态自证（ci-workflow AC7）

**结果：已验证**

验证流程：
1. 临时将 `ci-verify.yml` 中所有 `windows_smoke` 替换为 `win_smoke_REMOVED`（共 4 处）
2. 运行完整测试套件：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`
3. 输出中出现：`AssertionError [ERR_ASSERTION]: AC7 FAIL: ci-verify.yml 应包含 windows_smoke job`（以 unhandledRejection 形式）
4. 立即还原 `ci-verify.yml`
5. `git diff --stat .github/` → 无输出，workflows 目录零改动（已证明）

注意：受 Node.js 模块系统循环依赖限制，`tests/ci-workflow.test.ts` 无法用 `node --test` 单独运行（ERR_REQUIRE_CYCLE_MODULE），必须经 `all.test.ts` 的 void 链跑；红态证据来自全套测试的 unhandledRejection 报告行，而非 tap fail 计数——符合 spec 对 all.test.ts void 链的说明。

### SC5：tar 探测与引导错误

**结果：PASS**

`lib/runtime/python-installer.ts` `defaultInstallSteps.extract`（line 157-168）：
- `spawnSync("tar", ["--version"], { timeout: 5_000 })` 探测 tar 可用性
- 不可用时抛出：`"Windows 10 1803 以下需手动安装 Python 运行时或升级系统（tar 不可用，无法解压组件包）"`
- 含"手动安装"和"升级系统"两个关键词

测试通过 `InstallSteps` 注入替换 `extract` 模拟 tar 缺失（不做 PATH 劫持），验证：
- `result.ok === false`
- `result.detail` 含 "手动安装" 或 "升级系统"

静态源码扫断言同时确认 `spawnSync` 和引导文字存在于 installer 源码中。

### SC6：全量绿 + typecheck + lint + python 脚本零改动

**结果：PASS**

```
npm test → 11 tests pass, 0 fail, EXIT=0，零 unhandledRejection
npm run typecheck → EXIT=0
npm run lint → 0 errors（203 warnings 均为存量，EXIT=0）
git diff --stat workers/ → 无输出（python 脚本零改动）
git diff --stat .github/ → 无输出（workflows 零改动）
```

## 现场枚举 vs spec 清单差异

无差异。spec 列出 12 个调用点（无注入 6 处 + 已注入 4 处 + installer pip），收尾者现场 `rg` 独立枚举结果与 spec 完全一致，无发现清单外遗漏点。

`lib/agent/claude-adapter.ts:153` 含 `getPythonPath()` 引用但为注释文本，非 python 子进程调用点，不属于 spec 范围，确认无需处理。

## 红态证据

| 断言 | 来源 | 证据形式 |
|---|---|---|
| pythonSpawnEnv helper 输出/覆盖优先级 | 前任实施 | 11 tests pass（含 windows-hardening）|
| 调用点枚举扫描（12 处正向断言） | 前任实施 | 11 tests pass（含 windows-hardening）|
| tar 不可用引导错误（InstallSteps 注入） | 前任实施 | 11 tests pass（含 windows-hardening）|
| ci-verify.yml windows_smoke 存在 | 前任实施 + 收尾核对 | 红态收尾者补跑：unhandledRejection "AC7 FAIL: ci-verify.yml 应包含 windows_smoke job" |
| release.yml windows-latest 存在 | 前任实施 + 收尾核对 | 随上述红态测试通过隐含正向验证 |

## 偏差

无实质偏差。实施与 spec v1.1 完全对齐：

- helper 签名、合并语义、extra 展开顺序均符合 spec §0 定案
- 枚举断言覆盖 12 个调用点（正向包含断言），含 defaultRunner 函数体单独断言
- tar 探测通过 InstallSteps 注入，不做 PATH 劫持（符合 spec reviewer N2 定案）
- ci-workflow 红态验证临时改动已还原，.github/workflows 零落 git

## 开放风险

1. **tar 探测的真实 Windows 行为未验证**：`spawnSync("tar", ["--version"])` 在 Windows 10 1803 以下的表现（error 字段 vs status 非 0）在 mac CI 上无法验证，靠 windows_smoke job 中的 cargo check 覆盖 Rust 外壳；tar 探测本身的真实行为需目标机器核实。
2. **ci-workflow 测试的 void 链位置**：ciWorkflowTestPromise 目前在 all.test.ts 第 82 行（AC6.2 实跑 typecheck），windows-hardening 在 593 行。如 all.test.ts 链过长、某一环 unhandledRejection 在测试框架退出后到达，可能影响退出码捕获；现有运行结果显示正常（EXIT=0）。
3. **GBK 真实行为**：编码注入正确性在 mac/Linux 上是幂等操作，无副作用；GBK 实际防线效果仍依赖 CI windows_smoke 的 Windows 真实环境验证。
