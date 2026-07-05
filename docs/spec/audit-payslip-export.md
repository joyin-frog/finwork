# audit-payslip-export

> 实施者：claude-sonnet-4-6（implementer）
> 日期：2026-07-05
> 计划：docs/spec/spec-payslip-export.md（已批准）

## Files changed

| 文件 | 动作 | 对照 §2 |
|---|---|---|
| `lib/domain/payslip-export.ts` | 新增 | 同 §2 |
| `lib/agent/tools/finance/payroll.ts` | 修改 | 同 §2；签名加 `outputDir?`，加 `export_payslips` 工具 |
| `lib/agent/mcp-tools/index.ts` | 修改 | 同 §2；`createPayrollTools(sdk, outputDir)` |
| `workers/finance_worker.py` | 修改 | 同 §2；加 `cmd_export_payslips_xlsx()` + `main()` 分发 |
| `lib/agent/tools/registry.ts` | 修改 | 同 §2；注册 `export_payslips` medium |
| `lib/agent/roles/registry.ts` | 修改 | 同 §2；payroll-officer.tools 加 `export_payslips`，deliverables 加 `payslip_sheet` |
| `lib/agent/tools/renderers.ts` | 修改 | 同 §2；加 `export_payslips` 摘要（复用 `formatPeriod`） |
| `tests/payslip-export.test.ts` | 新增 | 同 §2；16 个测试（A1-A5 纯函数 / B1-B2 Python / C1-C9 源码契约） |
| `tests/all.test.ts` | 修改 | 同 §2；接入 `payslipExportTestPromise` |

**超出 Files touched 的文件**：无。

---

## §1 成功标准逐条核对

### A. 导出选择逻辑（纯函数）

| 标准 | 命令/断言 | 结果 |
|---|---|---|
| 只取 confirmed，draft 进 skippedDrafts | A1: `buildPayslipExport([confirmed, draft, confirmed], ...)` → rows.length===2, skippedDrafts===["李四"] | PASS |
| 无 confirmed → hasConfirmed=false | A4: 全 draft 记录 → hasConfirmed===false | PASS |
| 合计满足 sum(明细)=合计 | A2: 2人 grossPay=10000.1，totals.grossPay===20000.2，numericWarnings.length===0 | PASS |
| 精度：.1 边界 | A3: 3×0.1=0.3（浮点直接加=0.30000…4，整数分口径=0.3） | PASS |
| 不自洽时 numericWarnings 告警 | 实现中 collectNumericIssues 捕获并追加到 numericWarnings | 代码审查 PASS |

### B. 工具 + Python 导出

| 标准 | 命令/断言 | 结果 |
|---|---|---|
| export_payslips 工具存在并读 listPayrollRecords | C7: resolveRoleAllowedTools("payroll-officer") 含全名 | PASS |
| execFileSync 调 export-payslips-xlsx | B1: worker 直接调用 → 文件生成 | PASS |
| openpyxl 读回：表头含「姓名」「实发工资」 | B1 verifyCode: header.includes("姓名") && header.includes("实发工资") | PASS |
| 张三实发 === 8000 | B1: zhang_san_net_pay === 8000 | PASS |
| 实发合计 === 17450 | B1: total_net_pay === 17450 | PASS |
| 顶部标注「{year}年{month}月…已确认」| B1: title_row 含「2026年6月」 | PASS |
| 防覆盖版本化 _v2 | B2: 第二次导出 filePath.includes("_v2")，两份文件均存在 | PASS |
| skippedDrafts 提示「请先确认」 | 工具实现含 skippedDrafts 文本提示 | 代码审查 PASS |
| 文本经 redact() | C3: exportFnBody.includes("redact(") | PASS |
| Python 分发 export-payslips-xlsx | C6: finance_worker.py 含分发 + cmd 函数 | PASS |
| registry.ts medium | C4: snippet.includes("medium") | PASS |
| roles/registry.ts 含裸名 | C5: rolesSrc.includes('"export_payslips"') | PASS |
| renderers.ts 含摘要 | C8: renderersSrc.includes("export_payslips") | PASS |
| mcp-tools/index.ts 传 outputDir | C9: indexSrc.includes("createPayrollTools(sdk, outputDir)") | PASS |

### C. 数据信任

| 标准 | 验证 |
|---|---|
| 只导 confirmed | A1/A4 纯函数测试；工具实现检查 `!ex.hasConfirmed` 返回 isError | PASS |
| 无身份证/银行卡号 | C2: payroll.ts 不含 idCard / bankCard / 身份证 | PASS |
| 文件写入 outputDir | 工具实现：`outDir = outputDir ?? process.env.FINANCE_AGENT_OUTPUT_DIR ?? path.join(getAppDataDir(), "exports")`；mcp-tools/index.ts 传 outputDir（C9 确认） | PASS |

### D. 不回归

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```

结果：9 suites, 9 pass, 0 fail（reportlab ModuleNotFoundError 为预存在告警，与本 PR 无关）。

---

## 测试/typecheck 输出摘要

### 新测试（单独运行）

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/payslip-export.test.ts

payslip-export A1: 混合 draft/confirmed 过滤 ✓
payslip-export A2: 合计精度（整数分口径）✓
payslip-export A3: .1 精度边界 ✓
payslip-export A4: 空 confirmed 处理 ✓
payslip-export A5: 全 confirmed 无 skipped ✓
payslip-export B1: Python xlsx 生成 + openpyxl 读回校验 ✓
payslip-export B2: 防覆盖版本化 ✓
payslip-export C1: export_payslips 不写库 ✓
payslip-export C2: 无 PII payload ✓
payslip-export C3: 文本经 redact() ✓
payslip-export C4: registry.ts medium 注册 ✓
payslip-export C5: roles/registry.ts 白名单含 export_payslips ✓
payslip-export C6: finance_worker.py 分发存在 ✓
payslip-export C7: resolveRoleAllowedTools 含 export_payslips ✓
payslip-export C8: renderers.ts 含 export_payslips 摘要 ✓
payslip-export C9: mcp-tools/index.ts 传 outputDir ✓
payslip-export: 所有测试通过 ✓
```

### typecheck

```
npm run typecheck
# 输出：（无错误，干净退出）
```

### 全套回归

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# tests 9 / pass 9 / fail 0
```

---

## 三项核心自查

1. **只导 confirmed**：`buildPayslipExport` 中 `records.filter((r) => r.status === "confirmed")`；工具层若 `!ex.hasConfirmed` 返回 `isError`，不生成文件。draft 员工名进 `skippedDrafts` 且在文本响应中提示「请先确认」。

2. **无 PII**：payload 只含 `{outputPath, year, month, rows[], totals}`；rows 仅含 `employeeName + 6 个金额字段`（无身份证/银行卡号）。系统本不存 PII，payslip-export.ts 从 `StoredPayrollRecord` 取的字段也不含 PII。C2 源码契约测试断言 `payroll.ts` 不含 idCard/bankCard/身份证。

3. **文件写入 outputDir**：`lib/agent/mcp-tools/index.ts` 调用 `createPayrollTools(sdk, outputDir)`（C9 断言），`outputDir` 来自与 `createKingdeeTools(sdk, outputDir)` 同源的会话目录，确保文件进附件流。工具内 `outDir = outputDir ?? ...` 同 kingdee 模式。

---

## 偏离计划

无偏离。所有修改严格限于 §2 Files touched，照 §3 步骤实施。

## 遗留/风险

- **真机 preview**：本 session 为 CLI 模式，无法启动 dev server 目视附件流下载。标注"待人工目视"：confirm 一个月工资后触发 `export_payslips`，确认 xlsx 出现在对话附件流可下载区（复用 export_voucher_list 已验证链路）。
- **reportlab 告警**：skill-pdf 测试有 ModuleNotFoundError(reportlab) 的异步 unhandledRejection，为预存在问题（baseline 已存在），与本功能无关。
- **个税扣缴申报表/银行代发表**：明确属非目标（需 PII 主数据层），已在 spec 中记录，不在本期实施。
