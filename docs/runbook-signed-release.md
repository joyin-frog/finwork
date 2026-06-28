# Runbook: 签名发版(Tauri 更新器 + macOS 公证)

本文档面向仓库维护者,覆盖从密钥生成到验证自动更新的完整流程。
所有真实密钥/证书/凭证**仅存放在本地文件系统 + GitHub Secrets**,绝不提交到仓库。

---

## 所需 GitHub Secrets 清单

在 **仓库 → Settings → Secrets and variables → Actions** 中配置以下 secrets:

| Secret 名 | 用途 | 来源 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Updater 更新包签名私钥 | § 1 生成 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码短语 | § 1 生成时输入 |
| `TAURI_SIGNING_PUBLIC_KEY` | Updater 公钥(CI 构建期注入 tauri.conf.json) | § 1 生成 |
| `APPLE_CERTIFICATE` | Developer ID Application .p12 证书(base64 编码) | § 2 从 Keychain 导出 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 导出密码 | § 2 导出时设置 |
| `KEYCHAIN_PASSWORD` | CI 临时 keychain 密码(随机生成即可) | 自行设置 |
| `APPLE_SIGNING_IDENTITY` | 签名身份字符串,如 `Developer ID Application: 张三 (ABCD1234EF)` | § 2 |
| `APPLE_ID` | Apple Developer 账号 Email | § 2 |
| `APPLE_PASSWORD` | App-specific password(非 Apple ID 密码) | § 2 |
| `APPLE_TEAM_ID` | Apple Developer Team ID(10 位字母数字) | § 2 |
| `TELEMETRY_ENDPOINT` | 遥测上报端点(可选) | 单独部署 |
| `TELEMETRY_TOKEN` | 遥测鉴权 token(可选) | 单独部署 |
| `WINDOWS_CERT` | Windows 签名证书 .p12(base64,可选) | Windows 代码签名 CA |
| `WINDOWS_CERT_PASSWORD` | Windows 证书密码(可选) | Windows 代码签名 CA |

> 未配置可选 secrets 时对应步骤会被跳过,CI 不 fail。

---

## § 1 生成 Updater 密钥对

这是一次性操作,密钥对与 app 绑定。更换密钥对意味着旧版本无法自动更新到新版本,需要用户手动重装。

### 1.1 安装 Tauri CLI

```bash
npm install -g @tauri-apps/cli
# 或使用项目本地 CLI:
npx tauri --version
```

### 1.2 生成密钥对

```bash
# 生成到 ~/.tauri/ 目录(不在项目目录内,防止误提交)
npm run tauri signer generate -- -w ~/.tauri/finance-agent.key
```

交互式提示设置密码短语(passphrase),**记住它**。命令输出两个文件:

- `~/.tauri/finance-agent.key`      私钥(**绝不上传、绝不提交**)
- `~/.tauri/finance-agent.key.pub`  公钥(公开安全,需配置到 secrets 和 conf)

### 1.3 查看公钥内容

```bash
cat ~/.tauri/finance-agent.key.pub
# 输出一行 base64 字符串,形如:
# dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgQ...
```

### 1.4 配置 GitHub Secrets

将以下三个 secrets 填入仓库 Settings → Secrets → Actions:

| Secret 名 | 值 |
|---|---|
| `TAURI_SIGNING_PUBLIC_KEY` | `~/.tauri/finance-agent.key.pub` 文件的完整内容(一行 base64) |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/finance-agent.key` 文件的完整内容(多行,含头尾) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 步骤 1.2 输入的密码短语 |

> **验证**:CI 构建时 `prepare-tauri.mjs` 会读取 `TAURI_SIGNING_PUBLIC_KEY` 写入 `tauri.conf.json`;tauri-action 会读取 `TAURI_SIGNING_PRIVATE_KEY` 对更新包签名。

### 1.5(可选)本地文件方式

不想每次依赖 env,可把公钥存到 `src-tauri/updater-pubkey.txt`(已加入 `.gitignore`):

```bash
cp ~/.tauri/finance-agent.key.pub src-tauri/updater-pubkey.txt
```

`prepare-tauri.mjs` 优先读 env,次读此文件。

---

## § 2 Apple 凭证(macOS 公证)

### 2.1 前提条件

- 已加入 [Apple Developer Program](https://developer.apple.com/programs/)(年费 ¥688/99 USD)
- 在 Xcode → Settings → Accounts 中登录 Apple Developer 账号

### 2.2 创建 Developer ID Application 证书

1. 打开 [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)
2. 点击 **+** → 选择 **Developer ID Application** → Continue
3. 按提示生成 Certificate Signing Request(CSR)并上传
4. 下载证书 `.cer` 文件,双击安装到 Keychain

### 2.3 导出 .p12 证书

1. 打开 **钥匙串访问** → 登录 → 我的证书
2. 找到 `Developer ID Application: <你的名字> (<TeamID>)`
3. 右键 → **导出** → 选择 `.p12` 格式,设置导出密码
4. 将 .p12 转为 base64:
   ```bash
   base64 -i ~/Desktop/certificate.p12 | pbcopy  # macOS:复制到剪贴板
   ```

### 2.4 获取 App-specific password

1. 访问 [appleid.apple.com](https://appleid.apple.com) → 登录
2. App 专用密码 → 生成 → 输入标签(如 `finance-agent-ci`)→ 复制密码

### 2.5 获取 Team ID

1. 访问 [developer.apple.com/account](https://developer.apple.com/account)
2. 右上角显示 Team ID(10 位字母数字,如 `ABCD1234EF`)

### 2.6 配置 GitHub Secrets

| Secret 名 | 值 |
|---|---|
| `APPLE_CERTIFICATE` | 步骤 2.3 的 base64 字符串 |
| `APPLE_CERTIFICATE_PASSWORD` | 步骤 2.3 导出时设置的密码 |
| `KEYCHAIN_PASSWORD` | 任意随机密码(CI 用临时 keychain,如 `openssl rand -hex 16` 生成) |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 你的名字 (TeamID)` |
| `APPLE_ID` | 你的 Apple Developer 账号 Email |
| `APPLE_PASSWORD` | 步骤 2.4 的 App-specific password |
| `APPLE_TEAM_ID` | 步骤 2.5 的 Team ID |

---

## § 3 发布签名版本

### 3.1 确认 secrets 已全部配置

在 GitHub 仓库 → Settings → Secrets → Actions 核对 § 1 + § 2 的所有 secrets 已填入。

### 3.2 更新版本号

在 `src-tauri/tauri.conf.json` 中更新 `version` 字段:

```json
{
  "version": "1.2.0"
}
```

同步更新 `package.json` 的 `version` 字段(如需保持一致)。

提交版本变更:

```bash
git add src-tauri/tauri.conf.json package.json
git commit -m "chore: bump version to 1.2.0"
git push
```

### 3.3 打 tag 触发 CI

```bash
git tag v1.2.0
git push origin v1.2.0
```

### 3.4 CI 自动执行

GitHub Actions 触发 `.github/workflows/release.yml`:

1. **三个矩阵并行**:macOS arm64、macOS x64(Rosetta 交叉编译)、Windows x64
2. **每个 macOS job**:
   - 导入 Developer ID Application 证书到临时 keychain
   - `npm run build && npm run tauri:prepare`(含 pubkey 注入)
   - tauri-action 调用 `tauri build` — 编译、打包、`codesign`、生成带签名的 `latest.json`
   - `xcrun notarytool submit --wait`(提交公证,等待 Apple 服务端完成)
   - `xcrun stapler staple`(钉入公证票据)
   - 清理临时 keychain
3. **Windows job**:打包 .exe/.msi(WINDOWS_CERT 未配置则跳过签名)
4. **产物上传**:tauri-action 将 .dmg、.exe、.msi、`latest.json` 挂到 GitHub Release 草稿

### 3.5 核对产物

1. 进入 GitHub → Releases → 找到草稿 Release
2. 确认产物包含:
   - `Finance Agent_1.2.0_aarch64.dmg`(macOS Apple Silicon)
   - `Finance Agent_1.2.0_x64.dmg`(macOS Intel)
   - `Finance Agent_1.2.0_x64-setup.exe` / `.msi`(Windows)
   - `latest.json`(必须存在,含各平台签名)
3. 下载 `latest.json` 验证:
   ```bash
   curl -L https://github.com/joyin-frog/finwork/releases/latest/download/latest.json | python3 -m json.tool
   ```
   确认 `platforms` 下各平台有 `signature` 字段(非空字符串)。
4. macOS:下载 .dmg,双击挂载,将 .app 拖到 Applications,双击打开 — 若公证成功,**不会出现 Gatekeeper 警告**
5. 审核无误后将草稿发布为正式 Release

---

## § 4 验证自动更新

### 4.1 安装旧版本

安装一个较旧版本(如 v1.1.0)的 Finance Agent 到测试机器。

### 4.2 发布新版本

按 § 3 发布新版本(如 v1.2.0),确保 `latest.json` 已上传且 `version` 字段已更新。

### 4.3 触发更新检查

1. 打开旧版 Finance Agent
2. 进入 **设置 → 常规 → 应用更新**
3. 点击 **检查更新**

### 4.4 验证点

- [ ] 应用弹出提示,显示新版本号(如 `1.2.0`)和更新日志
- [ ] 点击**确认安装** — 开始下载新版本包
- [ ] 下载完成后提示安装,用户确认 → 安装 → 应用重启
- [ ] 重启后版本号更新为新版本
- [ ] macOS:重启后 Gatekeeper 不再提示(已公证)
- [ ] 签名校验失败(tamper 测试):手动修改 `latest.json` 中的 `signature` 字段,更新器应拒绝安装并报错

### 4.5 常见问题排查

| 问题 | 可能原因 | 排查方法 |
|---|---|---|
| 检查更新报"无法连接" | `endpoints` URL 不正确 | 检查 `tauri.conf.json` 的 `endpoints` 字段 |
| 检查更新报"签名校验失败" | pubkey/privkey 不匹配 | 核对 `TAURI_SIGNING_PUBLIC_KEY` 与 `.key.pub` 文件一致 |
| macOS 打开仍有 Gatekeeper 警告 | 公证未完成或 staple 失败 | 查看 CI 日志中的 `notarytool submit` 和 `stapler staple` 输出 |
| "更新源无效"或"无更新" | `latest.json` 未上传或版本号未增加 | 检查 Release 产物中是否含 `latest.json` |

---

## 文件与配置参考

- `src-tauri/tauri.conf.json` — updater 配置(`endpoints`、`pubkey`);pubkey 由 CI 构建期注入
- `scripts/prepare-tauri.mjs` — 构建期注入逻辑(读 `TAURI_SIGNING_PUBLIC_KEY` env 或 `src-tauri/updater-pubkey.txt`)
- `.github/workflows/release.yml` — 完整 CI 工作流(签名 + 公证 + 产物上传)
- `docs/updater-signing.md` — 更新器用户侧说明
- `src-tauri/updater-pubkey.txt` — 本地公钥文件(`.gitignore` 中,可选)
