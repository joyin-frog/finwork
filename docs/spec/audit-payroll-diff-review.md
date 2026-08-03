# audit-payroll-diff-review

> 实施者：claude-sonnet-4-6 (implementer)
> 日期：2026-07-05
> spec：docs/spec/spec-payroll-diff-review.md v1.0

## Files changed

所有文件均在 spec §2 Files touched 范围内，无超出。

| 文件 | 动作 | 改了什么 |
|---|---|---|
| `lib/domain/payroll-diff.ts` | 新增 | `computePayrollDiff` 纯函数 + 类型（`PayrollDiffField/Row/Result`）|
| `lib/db/finance-store.ts` | 修改 | 加 `getPriorConfirmedPeriod(year,month,db?)` 只读 helper |
| `lib/agent/tools/finance/payroll.ts` | 修改 | `createPayrollTools` 加 `diff_payroll_period` 只读工具；`return` 加入数组 |
| `lib/agent/tools/registry.ts` | 修改 | 加 `diff_payroll_period`，riskLevel:"safe" |
| `lib/agent/roles/registry.ts` | 修改 | `payroll-officer.tools` 加 `"diff_payroll_period"` 裸名 |
| `lib/agent/tools/renderers.ts` | 修改 | 加 `diff_payroll_period` 的 `getToolSummary` 条目，复用 `formatPeriod` |
| `app/components/payroll-diff-card-data.ts` | 新增 | `parsePayrollDiffStructured`：structuredContent → 卡片 props，严格校验，残缺回 null |
| `app/components/payroll-diff-card.tsx` | 新增 | 差异卡组件（表格 + 变动高亮 + 新增/漏算 + "草稿 vs 已确认"标签）|
| `app/components/tool-cards.tsx` | 修改 | `TOOLS_WITH_RESULT_CARD` 加 `diff_payroll_period`；`ToolResultCard` 加分发分支 |
| `tests/payroll-diff.test.ts` | 新增 | 15 项测试（D1-D9 纯函数；SC1-SC6 源码契约）；导出 `payrollDiffTestPromise` |
| `tests/all.test.ts` | 修改 | 接入 `payrollDiffTestPromise` |

---

## §1 成功标准逐条核对

### A. 差异计算（纯函数）

| 标准 | 验证方式 | 结果 |
|---|---|---|
| delta = round2(a*100-b*100)/100，精度到分 | D1（delta=183），D2（3000.10-1000.05=2000.05，1000.1-0.1=1000） | 通过 |
| 新增员工标 flag:"new" | D3 | 通过 |
| 漏算/dropped 检测 | D4 | 通过 |
| 排序：new 优先，再按 maxAbsDelta 降序 | D5 | 通过 |
| 税率版本差异标 flag:"tax_config_changed" | D6 | 通过 |
| 零差异 changed=false | D7 | 通过 |
| 空 priorRoster 冷启动全员 new、无 dropped | D8 | 通过 |

### B. 工具接线

| 标准 | 验证方式 | 结果 |
|---|---|---|
| 注册 diff_payroll_period 只读工具 | SC1 + `role-registry.test` G1/G4d | 通过 |
| registry.ts riskLevel:"safe" | SC3 | 通过 |
| payroll-officer 角色含该裸名 | SC4 | 通过 |
| renderers.ts 有摘要条目 | `tool-renderers.test` AC7 | 通过 |
| 文本走 redact() | SC2 | 通过 |
| structuredContent 无身份证/卡号 | 代码审查：只含 employeeName + 金额 delta | 通过 |

### C. 渲染

| 标准 | 验证方式 | 结果 |
|---|---|---|
| `TOOLS_WITH_RESULT_CARD` 含 diff_payroll_period | SC5 | 通过 |
| `ToolResultCard` 加分发分支 | SC5 | 通过 |
| 卡片明确标注"本月草稿 vs 上月已确认" | SC6（含"草稿"、"已确认"、"非环比"） | 通过 |
| 解析失败返回 null | `payroll-diff-card-data.ts` 严格校验逻辑 | 代码审查通过 |

### D. 不回归

| 标准 | 验证方式 | 结果 |
|---|---|---|
| 全套测试绿 | `npm test` exit 0，fail 0 | 通过 |
| typecheck 过 | `npm run typecheck` exit 0 | 通过 |
| 现有薪税工具/卡片不变 | diff 范围外文件未改动 | 通过 |

---

## 测试 / typecheck 输出摘要

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/payroll-diff.test.ts
→ D1-D9, SC1-SC6 全部 ✓
→ payroll-diff: all 15 tests passed ✓

node --import tsx tests/role-registry.test.ts
→ role-registry: all 7 guards passed ✓

node --import tsx tests/tool-renderers.test.ts
→ tool-renderers: all checks passed ✓

FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
→ # tests 9 / # pass 9 / # fail 0 (exit 0，165 个 ✓ 行，零 FAIL)

npm run typecheck
→ exit 0，无错误
```

---

## 只读性自查

- `diff_payroll_period` 工具体内：未调用 `savePayrollDraft`、未包裹 `withIdempotency`（SC1 断言覆盖）
- 未调用 `confirmPayrollPeriod`
- 未调用 `getLatestConfirmedPayroll`（已按 P1 修正用 `getPriorConfirmedPeriod`）
- `structuredContent` 字段：`year/month/comparedFromPeriod/rows[].employeeName/rows[].fields.*/newEmployees/dropped`——仅姓名 + 金额 delta，无身份证/卡号
- `getPriorConfirmedPeriod` 是纯 SELECT，只读

---

## 结算状态标注自查

- 文本输出开头：`【草稿复核，非环比趋势】`
- 卡片 header：`本月草稿 vs 上月已确认（{comparedFromPeriod}）· 仅供复核，非环比分析`
- `comparedFromPeriod` 通过 `structuredContent` 透传，卡片展示实际对比期间（如"2025年12月"），用户清楚跟哪个月比

---

## 偏离 / 遗留 / 风险

### 偏离

**无偏离。** 严格按 spec §3 步骤执行：
- P1 跨年修正：已用 `getPriorConfirmedPeriod`，未用 `getLatestConfirmedPayroll`；priorByName 与 priorRoster 同源期间
- P2 原子性：registry.ts + renderers.ts + roles/registry.ts 三处一并完成，未在中间态跑测试
- delta 精度：`Math.round(a*100 - b*100)/100`（先各自乘 100）
- 数据信任：文本和卡片均明确标注草稿/已确认，不猜因果

### 遗留（不阻塞，已知并接受）

- 真机目视：未启动 dev server 做 preview_screenshot（CI 环境无 Tauri；audit 标"待人工目视"）
- 卡片 FlagBadge 使用了 `color-mix(in oklch, ...)` 内联样式，而非 Tailwind 工具类——因为 `var(--tone-notice)/15` 在 Tailwind 需要 arbitrary value 且 CSS 层 oklch/15 等写法在旧 Tailwind 不支持。外观功能正确，与 `--tone-notice` token 正确关联。

### 风险

- `getPriorConfirmedPeriod` 注释已说明与 `getLatestConfirmedPayroll` 的区别（年内 vs 跨年）；未来维护者需注意不要混用
- `comparedFromPeriod` 可能不是"紧邻上月"（如跳月），已在卡片显示实际期间并在 spec §5 标注为已接受风险
