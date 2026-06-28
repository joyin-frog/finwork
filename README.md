# Finance Agent

> 面向 1–4 人小型财务团队的单机 AI 工作台。Next.js 15 + Claude Agent SDK + 本地 SQLite + Python worker,跑在 Tauri 2 桌面壳里。
> A local-first AI workstation for small finance teams (1–4 people). Built with Next.js 15, the Claude Agent SDK, local SQLite and a Python worker, packaged in a Tauri 2 desktop shell.

**中文** · [English](#english)

> ⚠️ **免责声明**：本工具的输出（含报销 / 薪税 / 对账 / 申报口径等）**不构成专业财税或法律意见**。所有数值与口径须经人工复核后使用，使用风险自负。
> ⚠️ **Disclaimer**: Outputs (including reimbursement, payroll, reconciliation, and filing guidance) are **not professional financial, tax, or legal advice**. Verify all figures before use; use at your own risk.

## 环境要求

- **Node 22+**（代码用 `node:sqlite`，Node 20 起不来）
- **Python 3.10+**（Excel / PDF worker 依赖）
- 桌面打包还需 **Rust** toolchain + 平台 C 工具链（macOS 装 Xcode Command Line Tools，Windows 装 MSVC）

## 启动

```bash
npm install
pip install -r requirements.txt        # Python worker 依赖
npm run dev                            # 浏览器版 → http://localhost:3000
```

首次进 `/config` → 模型，填 **API Key** 和 **模型 ID**（默认 `https://api.anthropic.com`，也可填任意 Anthropic 兼容网关）。不填则回落本地 mock，界面仍可用。

桌面版：

```bash
npm run tauri:dev          # 桌面开发
npm run tauri:build        # 打包，产物在 src-tauri/target/release/bundle/
```

数据写入系统应用数据目录（不写项目目录）：macOS `~/Library/Application Support/finance-agent/`、Windows `%APPDATA%\finance-agent\`、Linux `~/.local/share/finance-agent/`。

## 许可证

[AGPL-3.0](LICENSE)

---

<a name="english"></a>

# Finance Agent (English)

[中文](#finance-agent) · **English**

## Requirements

- **Node 22+** (uses `node:sqlite`; Node 20 won't start)
- **Python 3.10+** (for the Excel / PDF worker)
- For desktop builds: **Rust** toolchain + a platform C toolchain (Xcode Command Line Tools on macOS, MSVC on Windows)

## Run

```bash
npm install
pip install -r requirements.txt        # Python worker dependencies
npm run dev                            # web → http://localhost:3000
```

On first run, open `/config` → Model and set your **API Key** and **Model ID** (defaults to `https://api.anthropic.com`; any Anthropic-compatible gateway works). Without a key it falls back to a local mock, so the UI still runs.

Desktop:

```bash
npm run tauri:dev          # desktop dev
npm run tauri:build        # build → src-tauri/target/release/bundle/
```

Data is stored in the OS app-data directory (never in the project folder): `~/Library/Application Support/finance-agent/` (macOS), `%APPDATA%\finance-agent\` (Windows), `~/.local/share/finance-agent/` (Linux).

## License

[AGPL-3.0](LICENSE)
