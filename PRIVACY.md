# 隐私与数据说明 / Privacy & Data Notice

本文件说明 Finance Agent 如何存储和处理你的数据，以及哪些数据可能离开本机。

---

## 1. 本地存储

所有数据库（SQLite）、设置文件、会话文件栈以及知识文本镜像，均写入**系统应用数据目录**，不写入项目目录：

- macOS：`~/Library/Application Support/finance-agent/`
- Windows：`%APPDATA%\finance-agent\`
- Linux：`~/.local/share/finance-agent/`

你可随时在系统文件管理器里找到并删除这些文件。

---

## 2. 数据外发（关键）

**Agent 推理时会把相关数据发往你配置的 LLM 端点。** 这是本工具的核心工作方式，请务必了解：

- 你在 `/config` 里填写的 **LLM 端点**（默认 `https://api.anthropic.com`，也可填任意 Anthropic 兼容网关）会接收到对话上下文，其中包含与任务相关的财务数据片段。
- **这意味着数据会离开本机，传送至该端点。** 请确认你信任所配置的端点，并阅读该端点提供商的隐私政策（如 [Anthropic 隐私政策](https://www.anthropic.com/privacy)）。
- **敏感字段保护**：身份证号、银行卡号、个人薪资明细等高敏感字段在进入发往模型的上下文前，会经过脱敏 / 打码 / 用代号处理（对应架构红线 7）。但你仍应在配置端点时谨慎选择可信的服务提供商。
- **不填 Key 时**：系统回落本地 mock Agent，**不向任何外部端点发送数据**。

---

## 3. 遥测

**遥测默认关闭（opt-in）。**

- 官方发布包内置匿名遥测上报端点，但**默认不开启**；你需要在设置里主动打开。
- 开启后仅上报匿名错误信息与使用指标（不含财务数据；经脱敏处理，并通过出站黑名单断言确保不携带敏感字段）。
- 遥测接收端已以 **MIT 许可**开源，你可以自行审查上报内容与处理逻辑。
- 自行从源码构建的版本**没有内置上报端点**，遥测默认无效。
- 你可以随时在设置中关闭遥测。

---

## 4. 数据使用与出售

- **我们不出售你的数据。**
- 本工具不会在你不知情的情况下将你的数据共享给第三方。
- 你可随时关闭遥测、从本机删除所有应用数据（见第 1 节的数据目录）。

---

## 5. 联系

如有隐私方面的疑问或发现数据泄露问题，请通过 [SECURITY.md](SECURITY.md) 描述的负责任披露渠道联系维护者。

---

## English Summary

**Local storage**: All data (DB, settings, knowledge mirror, session files) is stored on your device in the OS app-data directory. Nothing is written to the project folder.

**Data egress**: When the AI agent reasons, it sends relevant (redacted) data to the LLM endpoint you configure in `/config` (default: `api.anthropic.com`). **Data leaves your machine to that endpoint.** Sensitive fields (ID numbers, bank account numbers, personal payroll details, etc.) are redacted/masked before being sent. Without an API key, the app falls back to a local mock and sends nothing externally.

**Telemetry**: Off by default (opt-in). When enabled, only anonymous error and usage metrics are sent — no financial data. The telemetry receiver is open-sourced under MIT.

**No data sales.** You can disable telemetry or delete all local data at any time.
