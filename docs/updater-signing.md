# 自动更新 & 签名配置指南

## 概览

Finance Agent 集成 [Tauri updater 插件](https://tauri.app/plugin/updater/),支持:
- 启动后"检查更新"按钮(设置 → 常规 → 应用更新)
- 发现新版本时展示版本号和更新日志
- **人工审核门**:用户确认后才下载安装,绝不静默更新

签名密钥由**你自己生成**,私钥留本机 + GitHub Secret,代码中只存公钥。

---

## 一次性配置(首次发版前完成)

### 1. 生成签名密钥对

```bash
npm run tauri signer generate -- -w ~/.tauri/finance-agent.key
```

交互式输入密码短语(passphrase),记住它。命令输出两个文件:
- `~/.tauri/finance-agent.key`        私钥(不要上传,不要提交)
- `~/.tauri/finance-agent.key.pub`    公钥(公开的,需填入 tauri.conf.json)

### 2. 将公钥填入 tauri.conf.json

打开 `src-tauri/tauri.conf.json`,找到:

```jsonc
"pubkey": "PLACEHOLDER_FILL_AFTER_RUNNING_npm_run_tauri_signer_generate"
```

替换为你的公钥文件内容(一行 base64 字符串):

```bash
cat ~/.tauri/finance-agent.key.pub
```

将输出粘贴进去。

### 3. 将 endpoint 替换为真实 GitHub 仓库地址

同在 `tauri.conf.json` 找到:

```
"https://github.com/OWNER/REPO/releases/latest/download/latest.json"
```

将 `OWNER` 和 `REPO` 替换为你的 GitHub 用户名和仓库名。

### 4. 将私钥和密码添加到 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret:

| Secret 名 | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/finance-agent.key` 文件的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 步骤 1 设置的密码短语 |

---

## 发版流程

```bash
git tag v1.2.0
git push origin v1.2.0
```

GitHub Actions 自动:
1. 为 macOS(arm64/x64)和 Windows 构建安装包
2. 使用 `TAURI_SIGNING_PRIVATE_KEY` 对每个包签名
3. 生成 `latest.json`(含版本号、下载 URL、各平台签名)
4. 将 `latest.json` 和安装包上传到 GitHub Release 草稿

审核草稿 → 发布 Release → 用户端「检查更新」即可发现新版本。

---

## 用户侧更新流程

1. 打开 Finance Agent → 设置 → 常规 → 应用更新
2. 点「检查更新」
3. 若有新版本,显示版本号和更新日志
4. 用户点「确认安装」→ 下载 + 校验签名 → 安装 → 应用重启
5. 取消则忽略(下次手动再检查)

**没有静默自动更新**——每次都需要用户手动触发并确认。

---

## 安全注意事项

- 私钥只存在 `~/.tauri/` 和 GitHub Secret 里,绝不提交到仓库
- 每次更新包都有 Tauri updater 的 Ed25519 签名校验,防篡改
- GitHub Secret 在 Actions 日志里自动掩码,不会泄露
