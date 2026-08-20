# Finwork

[![CI](https://github.com/joyin-frog/finwork/actions/workflows/ci.yml/badge.svg)](https://github.com/joyin-frog/finwork/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/joyin-frog/finwork?sort=semver)](https://github.com/joyin-frog/finwork/releases)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)

A local-first AI workspace for small finance teams, designed to keep everyday financial files and workflows on your own computer.

[Download the desktop app](https://github.com/joyin-frog/finwork/releases/latest) · [中文](README.md)

## What it does

- Reads, organizes, and creates Excel, Word, PDF, and other finance files
- Assists with expense review, payroll tax, financial analysis, and filing checks
- Extracts information from contracts, invoices, and policies into a local knowledge base
- Produces drafts for review before important results are used

Data is stored locally in a dedicated data directory; see the platform-specific locations below. The desktop app includes its runtime components, so users do not need to install Node.js, Python, or Rust.

> [!WARNING]
> Finwork does not provide professional financial, tax, or legal advice. Verify all figures and accounting treatments before use.

## Run from source

Source development requires Node.js 22+ and pnpm 11. Desktop development also requires Rust and the platform C toolchain. This repository uses pnpm only, with `pnpm-lock.yaml` as the sole dependency lockfile.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The first-run guide installs the required Python components and helps configure an API key and model. Without an API key, the interface remains available in local mock mode.

Desktop development and builds:

```bash
pnpm tauri:dev
pnpm tauri:build
```

## Data locations

- macOS: `~/Library/Application Support/Finwork/`
- Windows desktop release: sibling `Finwork Data` directory beside the install directory (for example, `D:\Finwork\Finwork.exe` stores data in `D:\Finwork Data\`); installations under protected `Program Files` use `%LOCALAPPDATA%\Finwork\`
- Windows source development: `%LOCALAPPDATA%\Finwork\`
- Linux: `~/.local/share/Finwork/`

## License

[AGPL-3.0](LICENSE)
