# Electron 签名发布与自动更新

Finwork 桌面发行主路径使用 electron-builder + electron-updater。设置页只负责检查更新；发现新版本后仍需用户明确确认，才会下载、安装并重启。

## 发布产物

推送与 `package.json.version` 一致的 tag（例如 `v0.2.0`）会触发 `.github/workflows/release.yml`，生成：

- macOS：arm64 / x64 的 DMG、ZIP、合并后的 `latest-mac.yml` 与 blockmap；
- Windows：x64 NSIS 安装器、`latest.yml` 与 blockmap；
- GitHub draft release：人工验收后再发布。draft 不会被客户端当成 latest 更新。

两个 macOS 架构先独立签名与打包，再由 `scripts/merge-electron-release.mjs` 合并更新元数据并统一上传，避免并行任务互相覆盖 `latest-mac.yml`。

本地目录包验证：

```bash
pnpm run build
pnpm run electron:prepare
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --config electron-builder.yml --dir
```

## GitHub Secrets

macOS 正式分发必须配置：

- `APPLE_CERTIFICATE`：Developer ID Application `.p12` 的 base64 内容；
- `APPLE_CERTIFICATE_PASSWORD`：`.p12` 密码；
- `APPLE_ID`：Apple ID；
- `APPLE_PASSWORD`：app-specific password；
- `APPLE_TEAM_ID`：开发者 Team ID。

Windows 正式分发必须配置：

- `WINDOWS_CERT`：代码签名证书文件、URL 或 base64 内容（electron-builder 的 `CSC_LINK` 格式）；
- `WINDOWS_CERT_PASSWORD`：证书密码。

tag 发布工作流会把上述凭证作为硬门禁：缺少任一项会直接失败，不会生成可供误发布的未签名 draft。macOS 构建后还会执行 `codesign`、notarization staple 与 Gatekeeper 校验；Windows 会验证主程序和 NSIS 安装器的 Authenticode 状态。需要内部未签名验证时，只能使用本地 `CSC_IDENTITY_AUTO_DISCOVERY=false` 构建命令。

## 安全边界

- 更新地址固定为 GitHub `joyin-frog/finwork` release provider；
- renderer 不直接接触 electron-updater，只能调用 preload 暴露的 `check / download / install` 三个动作；
- 下载前保留人工确认门；
- macOS 依赖 Developer ID 签名与公证，Windows 依赖 Authenticode；
- 发布前确认 `latest*.yml`、安装器和 blockmap 属于同一版本。

旧 Tauri Ed25519 updater key 不再用于 Electron 更新通道，可在回滚窗口结束后删除对应 Secrets。
