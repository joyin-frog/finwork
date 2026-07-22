# Audit: CR-S1 Spreadsheet Runtime Core

> Spec: `docs/spec/spec-spreadsheet-runtime-preflight.md`（Runtime Core）  
> 日期：2026-07-21  
> 批次：Batch 0  
> 判定：**Runtime Core 定向验收通过**；TaskContract / `waiting_dependency` 未接线（按设计）

## 产出

| 文件 | 动作 |
|---|---|
| `requirements.txt` | 锁定含 `xlrd==2.0.1` 等 |
| `runtime-lock/darwin-arm64.txt` + README | 平台 lock |
| `lib/runtime/python-installer.ts` | lock + stamp + `--require-hashes` |
| `lib/runtime/libreoffice-resolver.ts` | 系统 LO 解析 |
| `lib/runtime/spreadsheet-probe.ts` | `SpreadsheetCapabilities` + `getSpreadsheetCapabilities` |
| `lib/runtime/spreadsheet-runtime.ts` | probe/inspect/convert/recalc/render |
| `workers/finance_worker.py` | `.xls` → xlrd；convert-xls |
| `agent-skills/skills/xlsx/SKILL.md` | 去掉无 LO 跳过 / 临时 pip / Bash soffice |
| `tests/spreadsheet-probe.test.ts` 等 | 新增/更新 |
| `tests/fixtures/spreadsheet/` | fixture |

主代理合并：doctor 返回 `spreadsheet` capabilities。

## 验证

- `libreoffice-resolver.test.ts` ✓
- `spreadsheet-probe.test.ts` ✓（本机无 LO 时显式 skip recalc）
- `python-worker.test.ts` / `python-installer.test.ts` / `skill-xlsx.test.ts` ✓
- 本机 Finwork python-runtime 已补装 `xlrd==2.0.1`

## 残留

- TaskContract / preflight 阻断模型循环 → 等 CR-R0 冻结后接线
- Managed LibreOffice → CR-X2（未做）
- 非 darwin-arm64 的 lock 文件需 release 流水线补齐
