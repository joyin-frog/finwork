---
name: filing-precheck
title: 申报前复核
summary: 报税期前按清单逐项核验申报就绪度，输出三态清单（⚠️异常 / ❓无法核验 / ✅通过），异常项给定位与建议动作。
requires: "（可选）增值税申报表草稿、开票汇总、勾选认证汇总"
starter: "申报前帮我复核一遍"
category: finance
description: "用于报税前就绪度、申报数据和遗漏风险复核；正式申报或无申报意图时不用。输入纳税人画像及申报草稿/汇总，完成证据是按风险排序的异常、无法核验、通过三态清单。"
---

# 申报前复核 Skill

**定位：复核者助手，不代提交任何申报（红线）。**
**建议在新对话中运行，避免上下文被长对话挤占。**
**算术纪律：B 组全部数值比较必须调用 `run_python`（Decimal + 显式舍入），严禁心算勾稽。**

---

## 执行流程

### 第 0 步：前置采集——确认纳税人资格

从 system prompt C 段画像读取 `taxpayerType` 和 `region`。

- 若 `taxpayerType` 存在（一般纳税人 / 小规模）→ 继续第 1 步。
- 若 `taxpayerType` 缺失 → **必须先问用户**，给选项，不猜：

  > 请问贵公司的增值税纳税人资格是哪种？
  > A. 一般纳税人（增值税月报 + 附加税月报）
  > B. 小规模纳税人（按季申报，当前月份判断是否申报月）
  >
  > 请回复 A 或 B，或直接说明。

- 待用户确认后，按确认结果推导本期**申报义务清单**（A1），再进行后续检查项。

---

### 第 1 步：A 组——义务与数据就绪（全自动，不依赖上传文件）

**A1：义务清单推导**

根据 `taxpayerType`（已从画像或用户确认获取）推导本期申报义务：

- **一般纳税人**：增值税月报（含附加税月报：城建税、教育费附加、地方教育附加）+ 个税扣缴月报。
- **小规模纳税人**：判断本月是否为季度末月（3/6/9/12月），是 → 增值税季报月 + 个税扣缴月报；否 → 仅个税扣缴月报。

将上述义务清单列出，作为后续 B/C 组检查的范围依据。B6（季销售额 vs 免征额）仅对小规模纳税人执行。

**A2：申报截止日剩余天数**

- 口径：增值税申报截止为每月 15 日；个税扣缴申报截止为每月 15 日。
- 计算剩余天数，≤3 天标 ⚠️ urgent。
- 输出时注明："此日期未做节假日顺延计算，如遇节假日请自行核实主管税务机关的顺延安排。"

**A3：上月薪资期间状态**

调用 `query_payroll_status`，查询上月期间（如当前为 7 月申报，查 6 月薪资）。

- 若上月期间存在 **draft（未确认）** 记录 → ⚠️：**"上月薪资期间存在草稿未确认，草稿数据不能作为个税申报依据，请先在工资模块确认该期间后再申报。"**
- 若上月期间全为 **confirmed** → ✅：实发合计和人数已就绪。
- 若查无该期间数据 → ❓：无法核验，请确认上月薪资是否已录入系统。

**A4：本期开票/收票概况**

调用 `query_invoice_ledger`（入参：当前年月）查询发票台账汇总，按以下三分支处理：

- **有登记（total > 0）**：报告台账总张数、进项张数与税额合计，并与用户在本次对话中上传的开票汇总文件互证（若有文件，运行 `run_python` 比对张数；若无文件，提示"如有开票汇总文件可进一步比对"）。
  - 若 `directionUnknownCount > 0`：明示"其中 N 张历史记录未标注方向，未计入进项汇总，建议核实后补充方向信息"。
- **台账为空（total = 0）**：❓：**"请自查发票台账登记，确认本期开票与收票已全部登记。如已通过系统登记发票，台账将自动统计。"**

---

### 第 2 步：B 组——勾稽复算（需上传文件；缺哪项文件哪项标❓）

**进入条件**：用户已上传增值税申报表草稿、开票汇总、勾选认证汇总中的至少一份文件。若全无上传文件，B 组逐项输出 ❓ 并说明需要的文件，跳过 run_python 调用。

**算术纪律（每项均适用）**：
- 从文件中提取数字时，先明确列出"我从文件中读到的数值"。
- 所有比较和计算一律调用 `run_python`，代码中使用 `Decimal`，显式舍入到分（`.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)`）。
- 勾稽税率一律取自用户上传文件本身，不使用任何硬编码税率。
- `tax_calculator` 工具不用于此处（仅支持正向单 amount 计税，无法做申报表倒验），禁止调用。

**B1：销项税额勾稽**

文件来源：增值税申报表草稿中的销售额与销项税额。

```python
from decimal import Decimal, ROUND_HALF_UP
# 从文件读取（示例，实际值取自文件）
sales_amount = Decimal("XXX")   # 不含税销售额
tax_rate = Decimal("XXX")       # 适用税率，取自文件（如申报表表头）
declared_output_tax = Decimal("XXX")  # 申报表中的销项税额

# 计算复算销项税额
computed_output_tax = (sales_amount * tax_rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
diff = abs(computed_output_tax - declared_output_tax)

# 尾差阈值：1 元
THRESHOLD = Decimal('1.00')
if diff > THRESHOLD:
    result = f"⚠️ 差异 {diff} 元，超过 1 元阈值"
else:
    result = f"✅ 差异 {diff} 元，在 1 元阈值内"
print(result)
```

判定：差异 > 1 元 → ⚠️；否则 → ✅。

**B2：进项税额核验**

文件来源：增值税申报表中的抵扣进项税额 + 勾选认证汇总中的可抵扣金额。

```python
from decimal import Decimal, ROUND_HALF_UP
declared_input_tax = Decimal("XXX")   # 申报表抵扣进项税额
certified_deductible = Decimal("XXX") # 勾选认证可抵扣合计

if declared_input_tax > certified_deductible:
    excess = (declared_input_tax - certified_deductible).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    result = f"⚠️ 申报抵扣额超出勾选认证可抵扣额 {excess} 元，请核实"
else:
    result = f"✅ 申报抵扣额 ≤ 勾选认证可抵扣额，符合规则"
print(result)
```

判定：申报抵扣 > 勾选认证可抵扣 → ⚠️；否则 → ✅。

**B3：应纳税额勾稽链**

文件来源：申报表中销项税额、进项税额、上期留抵、应纳税额。

```python
from decimal import Decimal, ROUND_HALF_UP
output_tax = Decimal("XXX")      # 本期销项税额
input_tax = Decimal("XXX")       # 本期允许抵扣进项税额
carry_forward = Decimal("XXX")   # 上期留抵税额（申报表中）
declared_payable = Decimal("XXX")# 申报表中的应纳税额

computed_payable = (output_tax - input_tax - carry_forward).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
diff = abs(computed_payable - declared_payable)

THRESHOLD = Decimal('1.00')
if diff > THRESHOLD:
    result = f"⚠️ 勾稽差异 {diff} 元（复算={computed_payable}，申报={declared_payable}），请核查"
else:
    result = f"✅ 应纳税额勾稽通过，差异 {diff} 元在 1 元阈值内"
print(result)
```

判定：差异 > 1 元 → ⚠️；否则 → ✅。

**B4：附加税税基与税额复算**

文件来源：申报表中实缴增值税额 + 各附加税申报表（城建税率、教育费附加税率、地方教育附加税率，全部取自文件）。

```python
from decimal import Decimal, ROUND_HALF_UP
vat_paid = Decimal("XXX")         # 实缴增值税额（附加税税基），取自文件
city_rate = Decimal("XXX")        # 城建税率，取自文件（注：需核实当地税率）
edu_rate = Decimal("XXX")         # 教育费附加税率，取自文件（注：需核实当地税率）
local_edu_rate = Decimal("XXX")   # 地方教育附加税率，取自文件（注：需核实当地税率）

declared_city = Decimal("XXX")    # 申报城建税额
declared_edu = Decimal("XXX")     # 申报教育费附加
declared_local_edu = Decimal("XXX") # 申报地方教育附加

computed_city = (vat_paid * city_rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
computed_edu = (vat_paid * edu_rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
computed_local_edu = (vat_paid * local_edu_rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

THRESHOLD = Decimal('1.00')
results = []
if abs(computed_city - declared_city) > THRESHOLD:
    results.append(f"⚠️ 城建税差异 {abs(computed_city - declared_city)} 元")
if abs(computed_edu - declared_edu) > THRESHOLD:
    results.append(f"⚠️ 教育费附加差异 {abs(computed_edu - declared_edu)} 元")
if abs(computed_local_edu - declared_local_edu) > THRESHOLD:
    results.append(f"⚠️ 地方教育附加差异 {abs(computed_local_edu - declared_local_edu)} 元")

if results:
    print("\\n".join(results))
else:
    print("✅ 附加税税额勾稽通过（注：所用税率已取自文件，需核实当年当地政策）")
```

判定：任一差异 > 1 元 → ⚠️；全部通过 → ✅（附注"需核实当年当地政策"）。

**B5：个税申报数据与薪资系统核对**

口径说明：**`query_payroll_status` 返回已确认期间只有 `employeeName`、`netPay`（实发）、`taxCurrent`（个税）字段，没有应发（gross）字段**。本项对比口径 = 人数 + 实发合计（netPay）+ 个税合计（taxCurrent）。

数据来源：`query_payroll_status`（已在 A3 调用，取 confirmed 结果）+ 用户上传的个税申报数据文件。

```python
from decimal import Decimal, ROUND_HALF_UP
# 从 query_payroll_status 结果聚合
payroll_count = XXX                   # 已确认期间人数
payroll_net_total = Decimal("XXX")    # 实发合计（netPay 加总）
payroll_tax_total = Decimal("XXX")    # 个税合计（taxCurrent 加总）

# 从个税申报文件读取
declared_count = XXX
declared_net_total = Decimal("XXX")
declared_tax_total = Decimal("XXX")

THRESHOLD = Decimal('1.00')
issues = []
if payroll_count != declared_count:
    issues.append(f"⚠️ 人数不一致：工资系统 {payroll_count} 人，申报 {declared_count} 人")
if abs(payroll_net_total - declared_net_total) > THRESHOLD:
    diff = abs(payroll_net_total - declared_net_total).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    issues.append(f"⚠️ 实发合计差异 {diff} 元")
if abs(payroll_tax_total - declared_tax_total) > THRESHOLD:
    diff = abs(payroll_tax_total - declared_tax_total).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    issues.append(f"⚠️ 个税合计差异 {diff} 元")

if issues:
    print("\\n".join(issues))
else:
    print("✅ 个税申报数据（人数+实发合计+个税合计）与工资系统一致")
```

判定：差异 → ⚠️；一致 → ✅。

**B6：季销售额 vs 免征额（条件项：仅小规模纳税人）**

本项仅当 A1 确认为小规模纳税人且当月为季度末月时执行。

```python
from decimal import Decimal, ROUND_HALF_UP
quarterly_sales = Decimal("XXX")  # 本季度不含税销售额合计，取自文件
exemption_threshold = Decimal("XXX")  # 免征额，取自文件（注：需核实当年政策）

# 临界区：免征额 ±10% 范围内标⚠️提示
lower = (exemption_threshold * Decimal("0.9")).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
upper = (exemption_threshold * Decimal("1.1")).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

if quarterly_sales > exemption_threshold:
    result = f"⚠️ 季销售额（{quarterly_sales}）超过免征额（{exemption_threshold}），本季须申报纳税"
elif quarterly_sales >= lower:
    result = f"⚠️ 季销售额（{quarterly_sales}）在免征额 ±10% 临界区内，请仔细核实是否达到申报门槛（需核实当年政策）"
else:
    result = f"✅ 季销售额（{quarterly_sales}）低于免征额（{exemption_threshold}），符合免征条件（需核实当年政策）"
print(result)
```

判定：超过免征额 → ⚠️；临界区 → ⚠️；低于 → ✅（均附注"需核实当年政策"）。

**B7：开票汇总 vs 申报表口径差异**

文件来源：开票汇总合计 + 申报表销售额。

```python
from decimal import Decimal, ROUND_HALF_UP
invoice_total = Decimal("XXX")    # 开票汇总不含税金额合计，取自文件
declared_sales = Decimal("XXX")   # 申报表销售额，取自文件

if declared_sales == Decimal("0"):
    result = "❓ 申报表销售额为零，无法计算差异比例，请人工核对"
else:
    diff_ratio = abs(invoice_total - declared_sales) / declared_sales

    # 差异阈值：5%
    THRESHOLD_RATIO = Decimal("0.05")
    diff_amount = abs(invoice_total - declared_sales).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    diff_pct = (diff_ratio * 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

    if diff_ratio > THRESHOLD_RATIO:
        result = f"❓ 开票汇总与申报表差异 {diff_pct}%（{diff_amount} 元），超过 5% 阈值，请人工核对口径差异（如未开票收入、红字发票等）"
    else:
        result = f"✅ 开票汇总与申报表差异 {diff_pct}%（{diff_amount} 元），在 5% 阈值内"
print(result)
```

判定：差异 > 5% → ❓（请人工核对）；否则 → ✅。

---

### 第 3 步：C 组——遗漏风险提示（一批一起问，给选项）

将以下问题攒成一批，一次性向用户提出，给选项而非开放题：

> **申报遗漏风险确认——请逐项回答 是/否/不确定：**
>
> **C1.** 本期是否有新签合同或租赁协议？
> （如有，印花税申报可能需要，税目税率请核实当年当地政策）
>
> **C2.** 上期申报是否有留抵税额、更正申报或缓缴事项尚未处理完毕？
>
> **C3.** 已知：本复核清单中涉及的全部税率、免征额均应以当年当地政策为准，请在申报前自行核实。
>
> 请回复每项结论（是/否/不确定），如有"是"或"不确定"项，将进一步提示处理建议。

根据用户回答，对"是"或"不确定"项给出建议动作；"否"项记为 ✅ 已确认无此风险。

---

### 第 4 步：汇总输出

按以下格式输出复核清单，顺序固定：⚠️ → ❓ → ✅。

```
## 申报前复核清单

**核查范围**：[本期申报义务列表，基于 A1 推导]
**核查时间**：[当前日期]

---

### ⚠️ 异常项（需在申报前处理）

| # | 检查项 | 异常内容 | 建议动作 |
|---|--------|----------|---------|
| A2 | 申报截止日 | 距截止日仅剩 X 天 | 尽快完成申报 |
| B1 | 销项税额勾稽 | 差异 X 元，超 1 元阈值 | 核查申报表填写是否有误 |
| ... | | | |

（无异常项则说明：本次检查未发现异常项）

---

### ❓ 无法核验项（需补充数据或人工核实）

| # | 检查项 | 无法核验原因 | 需要的信息 |
|---|--------|------------|-----------|
| A4 | 发票台账 | 未上传文件 | 请自查发票台账登记情况 |
| B3 | 应纳税额 | 未上传申报表草稿 | 增值税申报表草稿 |
| ... | | | |

（无此类项则省略本节）

---

### ✅ 通过项

| # | 检查项 | 核验结果 |
|---|--------|---------|
| A3 | 上月薪资状态 | 已全部确认，实发合计 X 元，X 人 |
| ... | | |

（无通过项则省略本节）

---

**⚠️ 声明**：本复核为辅助性形式检查，不构成申报依据；税率、免征额等政策数值以当年当地主管税务机关规定为准；申报数据的准确性和完整性由纳税人负责；如有疑问，建议咨询税务师或拨打 12366。
```

---

## 输出段——清单物化（WP14a）

完成第 4 步汇总输出后，将 ⚠️ 与 ❓ 项物化为可勾选工件：

```
emit_checklist(
  title="申报前复核清单 [YYYY-MM]",
  items=[
    { label="[检查项]", detail="[异常内容/无法核验原因]", severity="warn" }
    // ⚠️ 项 severity="warn"；❓ 项 severity="info"
    // 仅列异常与无法核验项；✅ 通过项不纳入（不需跟进）
  ]
)
```

**正文 Markdown 表格保留**——工件是操作层（记录处理进度），不替代正文阅读层。

---

## 执行约束

- **不代提交任何申报**，不出具任何合规结论（红线）。
- **B 组算术严禁心算**：每一个数值比较必须调用 `run_python`，使用 `Decimal`，在代码中显式指定舍入方式和阈值。
- **`tax_calculator` 禁用于勾稽**：该工具只支持正向单 amount 计税，不用于申报表倒验比对。
- **政策数字零硬编码**：税率、免征额、附加税率一律取自用户上传文件；输出中所有政策相关项统一标注"需核实当年当地政策"。
- **缺数据宁可问人**：B 组无上传文件 → 逐项"❓无法核验 + 需要哪个文件"；画像缺 `taxpayerType` → 主对话直接问用户选项（一般/小规模），不默认。
- **B5 无应发字段**：`query_payroll_status` 返回的 confirmed 记录只有 `employeeName`/`netPay`/`taxCurrent`，无 gross 字段；对比口径 = 人数 + 实发合计 + 个税合计，明确输出中不包含应发数据。
- **B6 条件项**：仅小规模纳税人且当月为季度末月时执行，其余情况省略该项。
- **输出排序固定**：⚠️ 最前、❓ 次之、✅ 收尾，末尾必须有声明段。
