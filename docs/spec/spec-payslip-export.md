# 工资条导出（payslip-export）Spec

> 版本 v1.0 / 2026-07-05
> 状态：~~草案~~ → ~~已批准~~ → **已实施并 ship**（实施审查五条关键路径全过：零 PII / 只导已确认 / 文件进附件流 / Python 版本化 / 整数分勾稽；全套 + typecheck 绿）
> 依赖：`spec-payroll-diff-review.md`（F4 第一刀，已 ship）；本功能是 F4 第二刀（导出交差）
> 架构事实（写给没读过代码库的全新上下文实现者）：
> - 财务 Agent = Next.js + Tauri + `@anthropic-ai/claude-agent-sdk`（TS）+ Python 确定性算子 `workers/finance_worker.py`。
> - **确定性 xlsx 导出既定模式**（本功能照抄）：见 `export_voucher_list`（`lib/agent/mcp-tools/kingdee-tools.ts:560-611`）——TS 工具校验后：`outDir = outputDir ?? process.env.FINANCE_AGENT_OUTPUT_DIR ?? path.join(getAppDataDir(),"exports")`；`mkdirSync(outDir,{recursive:true})`；`fileName = path.basename(...)` 防路径穿越 + 强制 `.xlsx`；`execFileSync(getPythonPath(), [workerPath, "<子命令>"], {input: JSON.stringify(payload), encoding:"utf-8", timeout:60_000, env:{...process.env, PYTHONUTF8:"1", PYTHONIOENCODING:"utf-8"}})`；解析 `{filePath}`；返回 `structuredContent:{filePath, fileName}`。**xlsx 由 Python 写，禁止 LLM/TS 手拼**（"把最后一公里从 LLM 手里拿走"）。
> - Python 侧：`finance_worker.py` 有 `cmd_export_voucher_xlsx()`（:484，从 stdin 读 JSON、openpyxl `Workbook()` 写多 sheet），`main()`（:565）按 `sys.argv[1]` 分发子命令。**防覆盖不是全局自动的**——`cmd_export_voucher_xlsx` 直接调 `_next_versioned_path`（:495）做同名版本化（`_guarded_save` 猴子补丁只在 `cmd_run()` 里装，新子命令不走 `cmd_run` 拿不到它）。新命令须**照抄 `cmd_export_voucher_xlsx`：显式调 `_next_versioned_path` 得到真实落盘路径再 save**，并 `print(json.dumps({"filePath": <真实路径>}))`；TS 侧以回显 `filePath` 为准（别用请求名找文件）。
> - **薪税数据**：`lib/db/finance-store.ts` 的 `listPayrollRecords(year,month)` 返回 `StoredPayrollRecord[]`（:133-156，含 employeeName + grossPay/socialInsurance/housingFund/specialDeduction/taxCurrent/netPay + 累计字段 + `status:"draft"|"confirmed"`）。**系统不存身份证号/银行卡号**（见非目标）。
> - PII：文本输出经 `redact()`；金额精度校验 `checkSumConsistent`/`checkMoneyPrecision`（`lib/safety/numeric-check`）。工具注册 `lib/agent/tools/registry.ts`；角色白名单 `lib/agent/roles/registry.ts`（payroll-officer）；摘要 `lib/agent/tools/renderers.ts`。
> - 测试栈：`npm test` = `node --import tsx tests/all.test.ts`（聚合、无 jsdom、含 AC6.2 把 typecheck 纳入门禁）。Python 脚本测试见 `tests/export-voucher-list.test.ts`（`execFileSync` 调 worker 子命令断言输出）——本功能照此测 xlsx 生成。

## 0. 目标与非目标

**目标**：给薪税专员一个导出工具 `export_payslips`——把某月**已确认**工资导出成一张可直接交差的**工资明细表 xlsx**（每人一行：税前 / 五险 / 公积金 / 专项 / 个税 / 实发，含合计行），确定性生成（Python openpyxl），完成"确认后不用回 Excel 手工整理"的闭环最后一公里。

**非目标（本期不做，已知并接受）**：
- ❌ **个税扣缴申报表、银行代发表**——它们需要**身份证号 / 银行卡号 / 开户行**，而系统当前**不存任何员工 PII 主数据**（`payroll_records` 只有 `employee_name`）。补这两种导出必须先建"员工主数据层"（身份证/卡号），碰 PII 合规红线，是**独立决策与独立 spec**，不在本期，也不在本期偷偷建 PII 存储。
- ❌ 个人工资条逐人单页/加密/邮件发送——MVP 出一张明细表 sheet，够交差；逐人拆分/打印由用户在 Excel 做。
- ❌ 导出草稿工资：只导 `confirmed`（见成功标准/风险），draft 不当终值交付。
- ❌ 改计算引擎、diff 工具、确认流程。
- ❌ 引入 jsdom / 新 npm/py 依赖（openpyxl 已在用）。

## 1. 成功标准

**A. 导出选择逻辑（纯函数 `lib/domain/payslip-export.ts`，可自动验证）**
- [ ] `buildPayslipExport(records, year, month)`：只取 `status==="confirmed"` 的记录成表；`draft` 记录进 `skippedDrafts`（不入表）；无 confirmed → 返回空表 + 明确"该月无已确认工资，请先 confirm"。算合计（各金额列求和），合计满足 `明细之和=合计`（用 `checkSumConsistent` 校验，不自洽则带警告）。验证：单测——混合 draft/confirmed 只导 confirmed、draft 进 skipped；合计正确；空 confirmed 的处理。
- [ ] 金额精度：合计用整数分求和口径（`Math.round(x*100)` 累加后 /100），避免浮点尾差。验证：`.1` 类边界单测。

**B. 工具 + Python 导出（源码契约 + 脚本测试）**
- [ ] `export_payslips({year, month, fileName?})` 工具在 `payroll.ts`：读 `listPayrollRecords` → `buildPayslipExport` → 照 `export_voucher_list` 模式 `execFileSync` 调 `finance_worker.py export-payslips-xlsx`（payload 只含姓名 + 金额，**无 PII**）→ 返回 `{filePath, fileName}` + 建议调 `finalize_deliverable`。draft 存在时文本里列出"仍是草稿未导出：…，请先确认"。文本经 `redact()`。
- [ ] `finance_worker.py` 加 `cmd_export_payslips_xlsx()`（从 stdin 读 JSON，openpyxl 写"工资明细"sheet：表头 + 每人一行 + 合计行 + 顶部标注"{year}年{month}月 · 已确认"），并在 `main()` 分发 `export-payslips-xlsx`。复用既有防覆盖 guard，回显真实 `filePath`。
- [ ] `tools/registry.ts` 注册 `mcp__finance_worker__export_payslips`，`riskLevel:"medium"`（敏感产物但只生成本地文件、可逆、不需确认门）；`roles/registry.ts` payroll-officer.tools 加裸名；`renderers.ts` 加摘要（复用 `formatPeriod`）。**三处注册 + 工具实现原子同提交**（否则 role-registry.test G1/G4d、tool-renderers.test AC7 中间态必红）。
- [ ] Python 脚本测试（仿 `tests/export-voucher-list.test.ts`）：`execFileSync` 调 `export-payslips-xlsx` 喂样例 → 断言文件生成、openpyxl 读回表头/某人金额/合计一致。

**C. 数据信任**
- [ ] **只导 confirmed**（定版），draft 明确排除并提示——不把草稿当终值交付（结算状态红线）。
- [ ] 导出 payload 与 xlsx **无身份证/银行卡号**（系统没有，也不许现造）；文本响应 `redact()`。
- [ ] 合计与明细勾稽（`sum(明细)=合计`）。

**D. 不回归**：现有薪税工具/卡片不变；全套测试绿；typecheck 过。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/domain/payslip-export.ts` | 新增 | 纯函数 `buildPayslipExport(records, year, month)` + 类型：选 confirmed、算合计、分出 skippedDrafts。无 DB、无 IO。 |
| `lib/agent/tools/finance/payroll.ts` | 修改 | `createPayrollTools(sdk, outputDir?)` **签名加 `outputDir`**；加 `export_payslips` 工具（读 store → 纯函数 → execFileSync 调 worker，写到 `outputDir` → 返回 filePath）。 |
| `lib/agent/mcp-tools/index.ts` | 修改 | **【评审阻塞修正】** `createFinanceMcpServer` 里 `createPayrollTools(sdk)` → `createPayrollTools(sdk, outputDir)`（:37 附近）。否则 payslip xlsx 落到 `getAppDataDir()/exports`（会话目录外），**不会进对话附件流、用户下载不到**。`outputDir` 在该处已在作用域（与 `createKingdeeTools(sdk, outputDir)` 同源，:54）。 |
| `workers/finance_worker.py` | 修改 | 加 `cmd_export_payslips_xlsx()` + `main()` 分发 `export-payslips-xlsx`。 |
| `lib/agent/tools/registry.ts` | 修改 | 注册 `export_payslips`，`riskLevel:"medium"`。 |
| `lib/agent/roles/registry.ts` | 修改 | payroll-officer.tools 加 `"export_payslips"`；deliverables 可加 `"payslip_sheet"`。 |
| `lib/agent/tools/renderers.ts` | 修改 | 加 `export_payslips` 的 `getToolSummary`（复用 `formatPeriod`）。 |
| `tests/payslip-export.test.ts` | 新增 | ①纯函数（confirmed 选择/draft 跳过/合计/精度/空）；②Python 脚本（execFileSync 调子命令、openpyxl 读回校验）；③源码契约（工具只读库、无 PII payload、redact、注册 medium、角色白名单、Python 分发存在）。导出 `payslipExportTestPromise`。 |
| `tests/all.test.ts` | 修改 | 接入 `payslipExportTestPromise`。 |

> 需动列表外文件（如发现要落库导出记录、或要动附件流让文件在对话里可下载）就停下报告，不擅改——MVP 靠现有 outputDir → 附件流机制（`export_voucher_list` 已验证该链路可用）。

## 3. 实施步骤

1. **纯函数（`payslip-export.ts`）**：`PayslipRow = {employeeName; grossPay; socialInsurance; housingFund; specialDeduction; taxCurrent; netPay}`；`PayslipExport = {year; month; rows: PayslipRow[]; totals: {…6 列合计…}; skippedDrafts: string[]; hasConfirmed: boolean}`。`buildPayslipExport(records, year, month)`：`rows = records.filter(status==="confirmed").map(取 6 列)`；`skippedDrafts = records.filter(draft).map(name)`；合计按整数分累加（`Math.round(v*100)` 求和 /100）；`hasConfirmed = rows.length>0`。纯函数。
2. **Python（`finance_worker.py`）**：`cmd_export_payslips_xlsx()`：`payload = json.load(sys.stdin)`（含 `outputPath, year, month, rows[], totals`）；openpyxl `Workbook()`，sheet "工资明细"：第 1 行标注 `f"{year}年{month}月工资明细 · 已确认"`；表头 姓名/税前/五险/公积金/专项/个税/实发；每人一行；末尾合计行；**`realPath = _next_versioned_path(outputPath)` 再 `wb.save(realPath)`**（同 `cmd_export_voucher_xlsx`，不要指望全局 guard）；`print(json.dumps({"filePath": realPath}))`。`main()` 加 `elif sys.argv[1] == "export-payslips-xlsx": cmd_export_payslips_xlsx()`。
3. **工具（`payroll.ts`）**：`export_payslips({year, month, fileName?})`：`const recs = listPayrollRecords(year, month)`；`const ex = buildPayslipExport(recs, year, month)`；`!ex.hasConfirmed` → 友好 isError 文本（"该月无已确认工资，请先 calculate + confirm"）；否则照 `kingdee-tools.ts:566-611` 模式确定 outDir/basename/.xlsx、`execFileSync(getPythonPath(),[workerPath,"export-payslips-xlsx"],{input: JSON.stringify({outputPath, year, month, rows: ex.rows, totals: ex.totals}), …})`、解析 `{filePath}`、`redact()` 文本（含 skippedDrafts 提示"仍是草稿未导出：…"）、`structuredContent:{filePath, fileName: basename, skippedDrafts: ex.skippedDrafts}`。**payload 绝不含身份证/卡号（本就没有）。**
4. **注册（三处原子同提交）**：`registry.ts`（medium）+ `roles/registry.ts`（裸名）+ `renderers.ts`（摘要，复用 `formatPeriod`）。工具须先进 `TOOL_REGISTRY` 否则 `resolveRoleAllowedTools` 抛错。
5. **测试**：见 §4。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/payslip-export.test.ts
npm run typecheck
```
Python 脚本测试需 venv 里有 openpyxl（`requirements.txt` 已含）——参照 `tests/export-voucher-list.test.ts` 的 `execFileSync(pythonPath, [...])` 姿势，用临时 outputPath、跑完读回、断言后清理。

- 新增测试（进 `tests/payslip-export.test.ts`，接入 `all.test.ts`）：
  1. 纯函数：混合 draft/confirmed → 只导 confirmed、draft 进 skipped；合计正确 + `.1` 精度边界；空 confirmed → hasConfirmed=false。
  2. Python：喂 `{outputPath, year, month, rows, totals}` 调子命令 → 断言文件存在、openpyxl 读回表头 + 某人实发 + 合计一致。
  3. 源码契约：`payroll.ts` 的 `export_payslips` 工具体不写库（无 savePayrollDraft）、payload 不含 `身份证`/`idCard`/`bankCard`、输出走 `redact`；`registry.ts` 该工具 `medium`；`roles/registry.ts` payroll-officer 含裸名；`finance_worker.py` 含 `export-payslips-xlsx` 分发。
- 真机目视：起 dev server，confirm 一个月工资后触发 `export_payslips`，确认生成 xlsx 且可在对话附件流下载。跑不动 audit 标"待人工目视"。
- 先跑基线全绿再改，改完再跑，零回归。

## 5. 风险与开放问题

- **【结算状态红线】只导已确认**：工资条是对外/对员工的终值，绝不能导草稿。draft 一律排除并显式提示"请先确认"。
- **【PII 合规】无身份证/卡号**：本导出不含也不生成任何身份证/银行卡号（系统没有）。xlsx 里是姓名 + 金额，文件落本地 outputDir、不外发模型。申报表/代发表需要的 PII 主数据属独立决策（见非目标），本期不碰。
- **精度勾稽**：合计按整数分累加，满足 `sum(明细)=合计`；不自洽（`checkSumConsistent` 失败）时文本告警、不静默。
- **防覆盖**：同名重复导出由 worker 既有 `_guarded_save` 版本化；TS 以回显 `filePath` 为准。
- **附件下载链路**：MVP 复用 `export_voucher_list` 已验证的 outputDir → 附件流机制；若发现 payslip 文件未出现在对话可下载区，属该链路问题，停下报告而非在本 spec 里改附件流。
- **开放问题（不阻塞）**：是否加"逐人工资条单页 sheet"（每人一小块，便于裁剪）？MVP 先一张明细表；逐人版按需求再加，避免过早做。

---

## 附录：audit（implementer 产出 `docs/spec/audit-payslip-export.md`）
Files changed 清单开头（对照 §2）→ §1 逐条核对（命令+结果）→ 测试/typecheck 输出 → **只导 confirmed + 无 PII 自查** → 偏离/遗留/风险。
