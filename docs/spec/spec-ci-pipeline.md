# Spec：CI 流水线重构（借鉴 OpenHuman workflow）

> 目标读者：执行本 spec 的实现 Agent（sonnet）。
> 工作目录：仓库根目录，分支 `main`。**所有改动直接在 main 上做。**
> 性质：纯 CI/CD 改动，不碰产品代码。保持现有所有校验步骤的覆盖面不变，只改"怎么编排、怎么省、怎么快"。
> 来源：对照分析 `tinyhumansai/openhuman` 的 `.github/workflows/`（详见 [docs/openhuman-analysis.md](../openhuman-analysis.md)）。

---

## 0. 范围（要做的六项 + 明确不做的一项）

本 spec 落地以下 6 项（编号沿用分析讨论里的编号）：

| # | 名称 | 一句话 |
|---|---|---|
| 1 | 并发取消 | `concurrency` + `cancel-in-progress`，同一 PR 连推自动取消旧 run，省额度 |
| 2 | 路径过滤探测 | `dorny/paths-filter` 的 `changes` 前置 job，docs-only PR 跳过重活 |
| 4 | 拆并行 job | 把单体 `verify` 拆成 `checks / build / unit / e2e` 并行，反馈更快、一次看全失败 |
| 5 | 取消感知包装 | `scripts/ci-cancel-aware.sh` 包长命令，CI 取消时杀干净子进程树（对症 next-server 残留） |
| 6 | 缓存提速 | 缓存 Playwright 浏览器（`~/.cache/ms-playwright`）+ Next build 缓存（`.next/cache`） |
| 7 | release 先测后建 | release.yml 在三平台 Tauri 矩阵构建**之前**先跑完整校验（reusable workflow 复用，测试挂了不浪费构建） |

**明确不做（#3 聚合门 `pr-ci-gate`）**：用户本轮未选。注意其代价——见 §6「已知缺口」。本 spec 不实现它，但实现 Agent 必须在 PR 描述/提交信息里点明这个缺口，方便后续补。

**硬约束（不可破坏）**：
- Node 锁 `22`，Python 锁 `3.12`（与现状一致）。
- 现有全部校验必须仍然在 PR 上跑到：`lint` / `typecheck`（main 代码）/ `build`（next，全 runtime）/ `test`（单测）/ `eval:golden:ci`（SKIP_LLM golden）/ `test:e2e`（mock agent）。一个都不能丢。
- 失败时仍上传 Playwright 报告（`test-results/`、`playwright-report/`）。
- 不 push（只本地提交到 main）。`.github/workflows/` 的推送需要 workflow scope，本 spec 不负责推送。

---

## 1. 现状

`.github/workflows/ci.yml` 是**单个 `verify` job**，无论改了什么都串行跑全套：`checkout → setup node 22 (+npm cache) → npm ci → setup python 3.12 → python venv + pip install → lint → typecheck → build → test → eval:golden:ci → playwright install → test:e2e → 失败上传 artifact`。无 `concurrency`、无路径过滤、无 playwright/next 缓存、无取消感知。

`.github/workflows/release.yml`：tag `v*` 触发，直接进三平台 Tauri 矩阵构建（macOS arm64 / Intel / Windows），**构建前不跑测试**——测试挂了也要等三平台构建完才发现。

仓库顶层源目录：`app/ lib/ components/ hooks/ agent-skills/ e2e/ workers/ excel/ tests/ data/ scripts/ src-tauri/`；配置：`package.json package-lock.json next.config.ts tsconfig.json tsconfig.typecheck.json eslint.config.mjs postcss.config.mjs tailwind.config.ts instrumentation.ts playwright.config.ts components.json`；文档：`docs/ plans/ *.md`。

---

## 2. 目标文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/ci-cancel-aware.sh` | 新建 | 取消感知命令包装器（#5），`chmod +x` |
| `.github/workflows/ci-verify.yml` | 新建 | 可复用校验 workflow（`workflow_call`），含 `checks/build/unit/e2e` 四个并行 job（#4），被 ci 与 release 共用（#7） |
| `.github/workflows/ci.yml` | 重写 | PR 入口：`concurrency`（#1）+ `changes` 路径探测（#2）→ 按改动调用 `ci-verify.yml` |
| `.github/workflows/release.yml` | 改 | 加 `pretest` job 复用 `ci-verify.yml`，`build` 矩阵 `needs: pretest`（#7） |

---

## 3. 详细设计

### 3.1 `scripts/ci-cancel-aware.sh`（#5）

作用：包住长命令，当 GitHub 取消 job（发 SIGTERM/SIGINT）时，把**整个子进程树**杀干净，避免孤儿 next-server / playwright 进程占端口、占缓存锁（项目已知坑：stale next 进程叠端口→token 读空）。

实现要点（unix 为主，CI 跑在 ubuntu-latest）：
- 透传退出码（命令成功→0，失败→原码）。
- trap `INT TERM`：向子进程组发 TERM，宽限后发 KILL，再退出 130/143。
- 用 `setsid`（若可用）让子命令独占进程组，便于整组 kill。

写入以下内容（可按需小调，但行为必须等价）：

```bash
#!/usr/bin/env bash
# CI 取消感知命令包装器。
# 用法: scripts/ci-cancel-aware.sh <command> [args...]
# GitHub 取消 job 时会向本进程发 SIGTERM；本脚本把信号转成对整个子进程组的
# TERM→(宽限)→KILL，避免 next-server / playwright 等子进程变孤儿继续占端口。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

CHILD_PID=""
GRACE_SECS="${CI_CANCEL_GRACE_SECS:-10}"

cleanup() {
  local sig="$1"
  [ -n "$CHILD_PID" ] || return 0
  # 子进程独占进程组时，向 -PGID 发信号可命中整棵树。
  kill -TERM "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
  for _ in $(seq 1 "$GRACE_SECS"); do
    kill -0 "$CHILD_PID" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "-$CHILD_PID" 2>/dev/null || kill -KILL "$CHILD_PID" 2>/dev/null || true
}

trap 'cleanup TERM; exit 143' TERM
trap 'cleanup INT;  exit 130' INT

# setsid 让子命令成为新进程组组长，使 kill -PGID 能命中整棵进程树。
if command -v setsid >/dev/null 2>&1; then
  setsid "$@" &
else
  "$@" &
fi
CHILD_PID=$!

set +e
wait "$CHILD_PID"
STATUS=$?
set -e
exit "$STATUS"
```

> 注：macOS 无 `setsid`，会走 fallback 分支（直接后台跑 + 单进程 kill）。release 的非 ubuntu job 不用本脚本，所以 ubuntu 行为是主路径。

### 3.2 `.github/workflows/ci-verify.yml`（#4 + 复用底座）

可复用 workflow，四个**并行** job，每个用 `if: inputs.run_*` 受控（供 ci 按改动开关、供 release 全开）。

```yaml
name: CI Verify (reusable)

on:
  workflow_call:
    inputs:
      run_checks: { type: boolean, default: true }   # lint + typecheck
      run_build:  { type: boolean, default: true }   # next build（全 runtime）
      run_unit:   { type: boolean, default: true }   # 单测 + golden eval
      run_e2e:    { type: boolean, default: true }   # playwright mock e2e

permissions:
  contents: read

jobs:
  checks:
    if: inputs.run_checks
    name: Lint & Typecheck
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  build:
    if: inputs.run_build
    name: Build (Next, all runtimes)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Cache Next build
        uses: actions/cache@v4
        with:
          path: .next/cache
          key: nextcache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-${{ hashFiles('app/**/*.{ts,tsx,js,jsx,css}', 'lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}') }}
          restore-keys: |
            nextcache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}-
            nextcache-${{ runner.os }}-
      - run: bash scripts/ci-cancel-aware.sh npm run build

  unit:
    if: inputs.run_unit
    name: Unit + Golden (SKIP_LLM)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Setup Python worker venv
        run: |
          python -m venv workers/.venv
          workers/.venv/bin/python -m pip install --upgrade pip
          workers/.venv/bin/python -m pip install -r requirements.txt
      - run: bash scripts/ci-cancel-aware.sh npm test
      - run: bash scripts/ci-cancel-aware.sh npm run eval:golden:ci

  e2e:
    if: inputs.run_e2e
    name: E2E (mock agent)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Setup Python worker venv
        run: |
          python -m venv workers/.venv
          workers/.venv/bin/python -m pip install --upgrade pip
          workers/.venv/bin/python -m pip install -r requirements.txt
      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: pw-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
          restore-keys: |
            pw-${{ runner.os }}-
      - name: Install Playwright (chromium)
        run: npx playwright install --with-deps chromium
      - name: E2E (mock agent)
        run: bash scripts/ci-cancel-aware.sh npm run test:e2e
      - name: Upload E2E artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            test-results/
            playwright-report/
          retention-days: 7
          if-no-files-found: ignore
```

设计说明 / 注意：
- **Python venv 只放在 `unit` 和 `e2e`**（单测可能走 xlsx/pdf python worker，e2e 跑真 worker）。`checks` 和 `build` 不需要 python。**实现 Agent 必须验证：若 `npm test` 或 `npm run build` 在无 python 时失败，则把 python venv 步骤补到对应 job**（保守起见可先按本设计跑，CI 红了再补）。
- **golden eval 放在 `unit` job**（与单测同 lane，省一次 `npm ci`）。
- `build` 缓存 key 里的源码 hash 用 `app/lib/components` 的源文件；`hashFiles` 的 glob 写法若 actionlint 报错，退化为只按 `package-lock.json` 也可接受（缓存命中率略降，行为正确）。
- Playwright 浏览器缓存后仍跑 `--with-deps`（OS 依赖 apt 不可缓存，但浏览器二进制命中缓存即跳过下载）。

### 3.3 `.github/workflows/ci.yml`（#1 + #2）重写

```yaml
name: CI

# PR 或手动触发；push main 不自动跑（沿用现状，省额度）。
on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

# 同一 PR 连推自动取消进行中的旧 run。
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  changes:
    name: Detect Changed Areas
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      code: ${{ steps.filter.outputs.code }}
      e2e:  ${{ steps.filter.outputs.e2e }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 1 }
      - id: filter
        uses: dorny/paths-filter@v3
        with:
          filters: |
            code:
              - '.github/workflows/ci.yml'
              - '.github/workflows/ci-verify.yml'
              - 'scripts/ci-cancel-aware.sh'
              - 'package.json'
              - 'package-lock.json'
              - 'tsconfig*.json'
              - 'next.config.ts'
              - 'eslint.config.mjs'
              - 'postcss.config.mjs'
              - 'tailwind.config.ts'
              - 'instrumentation.ts'
              - 'components.json'
              - 'playwright.config.ts'
              - 'requirements.txt'
              - 'app/**'
              - 'lib/**'
              - 'components/**'
              - 'hooks/**'
              - 'agent-skills/**'
              - 'excel/**'
              - 'workers/**'
              - 'tests/**'
              - 'e2e/**'
              - 'data/**'
              - 'scripts/**'
            e2e:
              - '.github/workflows/ci.yml'
              - '.github/workflows/ci-verify.yml'
              - 'scripts/ci-cancel-aware.sh'
              - 'package.json'
              - 'package-lock.json'
              - 'next.config.ts'
              - 'instrumentation.ts'
              - 'playwright.config.ts'
              - 'requirements.txt'
              - 'app/**'
              - 'lib/**'
              - 'components/**'
              - 'hooks/**'
              - 'agent-skills/**'
              - 'excel/**'
              - 'workers/**'
              - 'e2e/**'

  verify:
    name: Verify
    needs: changes
    uses: ./.github/workflows/ci-verify.yml
    with:
      run_checks: ${{ needs.changes.outputs.code == 'true' }}
      run_build:  ${{ needs.changes.outputs.code == 'true' }}
      run_unit:   ${{ needs.changes.outputs.code == 'true' }}
      run_e2e:    ${{ needs.changes.outputs.e2e == 'true' }}
```

说明：
- 纯 docs/plans/`*.md` 改动 → `code` 与 `e2e` 都 false → 四个 lane 全 skip，只跑廉价的 `changes`（最大省额度收益）。
- 改了源码 → `code` true 跑 checks/build/unit；改了运行时/journey 相关 → `e2e` true 跑 e2e。
- `run_*` 用 `== 'true'` 把 paths-filter 的字符串输出转成布尔传给 reusable 的 boolean input（GitHub 会按 input 类型 coerce；显式比较更稳）。

### 3.4 `.github/workflows/release.yml`（#7）改造

在现有 `build` job **之前**插入一个 `pretest` job 复用 `ci-verify.yml`（全 lane 默认开），并让 `build` 依赖它：

```yaml
jobs:
  pretest:
    name: Pretest (full verify)
    uses: ./.github/workflows/ci-verify.yml

  build:
    needs: pretest          # ← 新增：测试不过不进昂贵的三平台构建
    strategy:
      # ...（保持现有 matrix 不变）
```

约束：
- **只新增 `pretest` job + 给 `build` 加 `needs: pretest`**，`build` 矩阵其余内容（macOS arm64/Intel 交叉编译、Windows、secrets→boolean 旗标、签名/公证、Rosetta、artifact 上传等）**逐字保持不变**。
- 不改 release 的触发器（仍 `push tags v*`）和 `permissions: contents: write`。
- reusable workflow 自带 `permissions: contents: read`，与 release 的 write 不冲突（各 job 独立）。

---

## 4. 验收标准

1. 四个新增/改动文件存在且语法合法（见 §5 校验）。
2. `ci.yml` 含 `concurrency.cancel-in-progress: true`、`changes` job、`verify` 通过 `uses:` 调 `ci-verify.yml` 并按 `changes` 输出开关 lane。
3. `ci-verify.yml` 四个 job 覆盖原有全部校验：lint、typecheck、build、test、eval:golden:ci、test:e2e；失败仍上传 `test-results/` + `playwright-report/`。
4. `build` 和 `e2e` job 分别有 `.next/cache` 与 `~/.cache/ms-playwright` 缓存步骤。
5. 长命令（build / test / golden / e2e）通过 `bash scripts/ci-cancel-aware.sh` 调用；脚本可执行（`-x`）。
6. `release.yml` 有 `pretest`（`uses: ./.github/workflows/ci-verify.yml`）且 `build` `needs: pretest`；build 矩阵其余不变。
7. Node 仍 22，Python 仍 3.12。
8. 不破坏 `release.yml` 的签名/交叉编译逻辑（`git diff` 里 build 矩阵只多出 `needs: pretest` 一行）。

## 5. 校验步骤（实现 Agent 必须执行）

在仓库根目录下：

1. **YAML 合法性**：对四个 yml 各跑 `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <file>`。
2. **actionlint（若可用）**：`command -v actionlint && actionlint` 或 `npx --yes actionlint`（装不上不强求，但要在提交信息注明未跑）。
3. **脚本可执行**：`test -x scripts/ci-cancel-aware.sh`；`bash -n scripts/ci-cancel-aware.sh`（语法检查）；本地 smoke：`bash scripts/ci-cancel-aware.sh echo ok` 输出 `ok` 且退出 0；`bash scripts/ci-cancel-aware.sh false` 退出码为 1（透传）。
4. **reusable 引用路径**：确认 ci.yml / release.yml 里 `uses: ./.github/workflows/ci-verify.yml` 路径正确。
5. **release diff 审查**：`git diff` 确认 release.yml 除新增 pretest + `needs: pretest` 外无其他改动。
6. 不在本机真跑 GitHub Actions（无法）；不 push。

## 6. 已知缺口（实现 Agent 必须在提交信息/PR 描述里点明）

- **未实现 #3 聚合门（`pr-ci-gate`）**：现在 `verify` 是 reusable，其内部 lane 会按 `changes` 条件 skip。若将来在 branch protection 里把单个 lane 设为"必过检查"，skip 的 lane 可能影响必过门判定。当前仓库 CI 不 push-main、未见强制 branch protection，影响有限。后续若加 branch protection，应补一个 `if: always()` 的聚合 job（needs 全部 lane，逐个要求 `success` 或 `skipped`），并只把它设为 required check。
- Python venv 当前只在 unit/e2e；若 build/checks 在 CI 上因缺 python 而红，需补对应步骤（见 §3.2）。

## 7. 提交

- 在 `main` 上提交（工作目录：仓库根目录）。
- commit message 用 conventional commits，中文，例如：
  `ci: 重构 PR 流水线——并发取消/路径过滤/并行 job/取消感知/缓存提速 + release 先测后建`
  正文列出落地的 #1/#2/#4/#5/#6/#7，并注明 §6 的两条缺口。
- 结尾加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（实现 Agent 用 sonnet，但保持仓库约定的署名格式）。
- **不要 push。**
