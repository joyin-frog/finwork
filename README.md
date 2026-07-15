# Finwork

[![CI](https://github.com/joyin-frog/finwork/actions/workflows/ci.yml/badge.svg)](https://github.com/joyin-frog/finwork/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/joyin-frog/finwork?sort=semver)](https://github.com/joyin-frog/finwork/releases)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)

面向 1–4 人财务团队的本地优先 AI 工作台，让日常财务资料和处理流程留在自己的电脑上。

[下载桌面版](https://github.com/joyin-frog/finwork/releases/latest) · [English](README.en.md)

## 能做什么

- 读取、整理和生成 Excel、Word、PDF 等财务文件
- 辅助报销审核、薪税计算、财务分析、申报复核等工作
- 从合同、发票和制度文件中提取信息，沉淀到本地知识库
- 关键结果先生成草稿，由财务人员确认后再使用

数据默认保存在本机的独立数据目录，不写入项目目录；各平台位置见下文。桌面版已包含运行所需组件，无需另行安装 Node.js、Python 或 Rust。

> [!WARNING]
> Finwork 的输出不构成专业财税或法律意见。所有数值与业务口径均须人工复核后使用。

## 从源码运行

需要 Node.js 22+；开发桌面版还需要 Rust 及对应平台的 C 工具链。

```bash
npm install
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。首次启动向导会安装所需的 Python 组件，并引导配置 API Key 和模型；未配置 API Key 时，界面仍可通过本地模拟模式运行。

桌面开发与打包：

```bash
npm run tauri:dev
npm run tauri:build
```

## 数据位置

- macOS：`~/Library/Application Support/Finwork/`
- Windows 桌面发行版：安装目录的同级 `Finwork Data`（例如程序位于 `D:\Finwork\Finwork.exe`，数据位于 `D:\Finwork Data\`）；若安装在受保护的 `Program Files` 下，则使用 `%LOCALAPPDATA%\Finwork\`
- Windows 源码开发：`%LOCALAPPDATA%\Finwork\`
- Linux：`~/.local/share/Finwork/`

## 许可证

[AGPL-3.0](LICENSE)
