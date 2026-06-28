# Spec:签名分发(Tauri 更新器 + macOS 公证)

## 背景与目标
现状:`src-tauri/tauri.conf.json` 的 updater pubkey 是 `PLACEHOLDER_FILL_AFTER_RUNNING_npm_run_tauri_signer_generate`,macOS 未公证 → **用户双击被 Gatekeeper 拦、自动更新跑不了**。本特性把签名分发的**代码/配置/工作流脚手架**搭好,并写清用户必须手动做的密钥/凭证步骤。

## 重要边界(诚实,执行者必读)
- 执行者**不能**生成真实签名密钥、不能做真实公证(需要用户的 Apple Developer 账号、实际密钥、GitHub secrets)。
- 所以**可验证产出** = 正确的配置结构 + release.yml 工作流步骤 + 完整 runbook + 现有构建不被破坏;**不可验证** = 真实签名/公证产物(用户配 secrets 后由 CI 跑)。
- **禁止把任何真实密钥/证书/凭证写进仓库**。占位符必须明确标注,并在 runbook 指明替换处。
- 不破坏 dev:缺密钥/secrets 时,本地 `npm run tauri` dev 与 CI 普通构建仍能跑(updater 功能降级,不崩、不 fail)。

## 设计

### 1. Tauri updater 配置(`tauri.conf.json` + `scripts/prepare-tauri.mjs`)
- pubkey 不再硬编码 PLACEHOLDER:改为**构建期注入**——`prepare-tauri.mjs` 从 env `TAURI_SIGNING_PUBLIC_KEY`(或一个 `src-tauri/updater-pubkey.txt`,gitignore)写入 conf;env 缺失时保留一个明确的空/占位并**打印告警**(不崩)。
- `endpoints` 指向 GitHub releases 的 latest.json:
  `https://github.com/<OWNER>/<REPO>/releases/latest/download/latest.json`(OWNER/REPO 从现有仓库或 env 取;若现仓库已知就直接填)。
- 确认 `plugins.updater` 配置项齐全(endpoints、pubkey、windows install mode 等)与 Tauri 2 schema 对齐。

### 2. release.yml 公证 + 签名(`.github/workflows/release.yml`)
- **Tauri updater 私钥签名**:tauri build 步骤注入 `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`(来自 secrets);tauri-action 会用它签更新包并生成 `latest.json`。确认 latest.json 进 release 产物。
- **macOS codesign + 公证**(在 macOS job、tauri build 后):
  - `codesign` 用 Developer ID Application 证书(从 secret 导入到临时 keychain);
  - `xcrun notarytool submit --wait`(用 `APPLE_ID` / `APPLE_PASSWORD`(app-specific) / `APPLE_TEAM_ID` secrets);
  - `xcrun stapler staple`。
  - **全部 gated**:`if: ${{ secrets.APPLE_ID != '' }}` 之类——secrets 缺则**跳过这些步骤、出未签名产物、不 fail job**(保证没配 secrets 的 fork/CI 仍绿)。
- **Windows**(可选/脚手架):签名步骤留 `if: secrets.WINDOWS_CERT != ''` 的占位 + 注释,不强求。
- 不改变现有"推 tag 触发 + 挂 GitHub 草稿 Release + arm64/Intel/Windows 矩阵"的主结构,只**加签名/公证步骤**。

### 3. Runbook(`docs/runbook-signed-release.md`)
逐步覆盖四段,让 OWNER 照着就能发一个真签名版:
1. **生成 updater keypair**:`npm run tauri signer generate`(或 tauri CLI)→ 公钥填进配置来源(env / pubkey 文件)、私钥 + 密码进 GitHub secrets(`TAURI_SIGNING_PRIVATE_KEY`、`..._PASSWORD`)。
2. **Apple 凭证**:Developer ID Application 证书(导出 .p12 + 密码)、App-specific password、Team ID → 对应 GitHub secrets;列全 secret 名清单。
3. **发布**:打 `vX.Y.Z` tag 触发 → 核对产物已签名/公证/带 `latest.json`。
4. **验证自动更新**:装一个旧版本 → 发新版本 → app 内检到并完成更新(给出验证点)。

## 验收(AC)
- **AC1** `tauri.conf.json` 不再含硬编码 `PLACEHOLDER_...` pubkey;改为构建期注入 + `endpoints` 指向 GitHub releases `latest.json` 模式;缺 env 时 `prepare-tauri.mjs` 告警但不崩。
- **AC2** `release.yml` 含 macOS codesign + notarytool + staple 步骤,且**全部 gated on secrets 存在**(缺则跳过、CI 不 fail)。
- **AC3** `release.yml` 含 updater 私钥签名 + 产出 `latest.json` 进 release。
- **AC4** `docs/runbook-signed-release.md` 完整覆盖四段 + 列全所需 GitHub secrets 名。
- **AC5** 仓库零真实密钥/证书/凭证;所有占位明确可识别。
- **AC6**(回归)`npm run typecheck` / `npm test` / `npm run lint` 仍全绿;`prepare-tauri.mjs` 在无 env 下能正常跑完(dev/CI 不破)。

## 测试与验证
- 配置/YAML/docs 难单测。验证方式:
  - `tauri.conf.json` JSON 合法 + updater 段结构正确(可加一个轻 TS 测试解析它、断言 endpoints 是 github releases 模式、pubkey 非 PLACEHOLDER 硬编码)。
  - `release.yml` YAML 解析通过(可用 node 解析或 `python3 -c yaml.safe_load`)。
  - 手动核对 runbook 自检清单完整、secret 名与 release.yml 引用一致。
- 把"轻配置测试"wire 进 `tests/all.test.ts`(若加)。

## 改完必跑
`npm run typecheck` · `npm test` · `npm run lint` 全绿;`node scripts/prepare-tauri.mjs`(或等价)在无 `TAURI_SIGNING_PUBLIC_KEY` 下不报错退出。

## 不做(本期边界)
- 真实生成密钥 / 真实公证 / 真实发布(用户手动 secrets 后由 CI 跑)。
- Windows 签名只搭 gated 脚手架,不强求跑通。
