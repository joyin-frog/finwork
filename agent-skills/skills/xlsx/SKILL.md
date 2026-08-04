---
name: xlsx
title: Excel 表格处理
summary: 读写、整理、对账 Excel 和 CSV 表格,加列、算公式、做图表、清洗数据。
requires: "Excel 或 CSV 文件"
category: file-tool
description: "用于读取、创建或编辑 Excel/CSV，也用于把比较、对账结果交付为表格；Word/PDF、纯分析文字或数据库任务不用。输入表格与目标，完成证据是可打开、公式无错误且不覆盖原件的表格。"
---


## 输出要求

### 所有 Excel 文件

#### 专业字体
- 除非用户另有指示，所有交付物均使用一致的专业字体（例如 Arial、Times New Roman）

#### 零公式错误
- 每个 Excel 模型交付时必须保证零公式错误（#REF!、#DIV/0!、#VALUE!、#N/A、#NAME?）

#### 保留现有模板（更新模板时）
- 修改文件时，学习并精确匹配现有格式、样式和约定
- 切勿对已有既定模式的文件强加标准化格式
- 现有模板的约定始终优先于这些指南

---

## 财务模型

### 颜色编码标准
除非用户或现有模板另有说明

#### 行业标准颜色约定
- **蓝色字体（RGB: 0,0,255）**：硬编码输入，以及用户会为不同情景更改的数字
- **黑色字体（RGB: 0,0,0）**：所有公式和计算
- **绿色字体（RGB: 0,128,0）**：从同一工作簿内其他工作表引用的链接
- **红色字体（RGB: 255,0,0）**：指向其他文件的外部链接
- **黄色背景（RGB: 255,255,0）**：需要关注的关键假设或需要更新的单元格

### 数字格式标准

#### 必需的格式规则
- **年份**：格式化为文本字符串（例如，"2024" 而非 "2,024"）
- **货币**：使用 $#,##0 格式；始终在表头中指定单位（"收入（百万美元）"）
- **零值**：使用数字格式将所有零值显示为 "-"，包括百分比（例如，"$#,##0;($#,##0);-"）
- **百分比**：默认使用 0.0% 格式（一位小数）
- **倍数**：估值倍数（EV/EBITDA、市盈率）格式化为 0.0x
- **负数**：使用括号 (123) 而非减号 -123

---

### 公式构建规则

#### 假设项的放置
- 将所有假设项（增长率、利润率、倍数等）放置在单独的假设单元格中
- 在公式中使用单元格引用而非硬编码值
- 示例：使用 =B5*(1+$B$6) 而非 =B5*1.05

#### 公式错误预防
- 验证所有单元格引用是否正确
- 检查范围是否存在差一行错误
- 确保所有预测期间公式一致
- 使用边界情况进行测试（零值、负数）
- 验证没有意外的循环引用

#### 硬编码值的文档要求
- 在单元格中或旁边添加注释（如果在表格末尾）。格式："来源：[系统/文档]，[日期]，[具体引用]，[URL（如有）]"
- 示例：
  - "来源：公司 10-K，FY2024，第 45 页，收入附注，[SEC EDGAR URL]"
  - "来源：公司 10-Q，Q2 2025，附录 99.1，[SEC EDGAR URL]"
  - "来源：彭博终端，2025年8月15日，AAPL US Equity"
  - "来源：FactSet，2025年8月20日，一致预期屏幕"

---

## XLSX 创建、编辑和分析

### 概述

用户可能会要求您创建、编辑或分析 .xlsx 文件的内容。针对不同的任务，您可以使用不同的工具和工作流程。

### 重要要求

**写入 XLSX 不依赖 LibreOffice**：先用 openpyxl/pandas 正常创建或修改工作簿并保存。LibreOffice 只用于公式缓存刷新与渲染验证，不是写文件的前提。

**公式重算由产品 Runtime 负责**：不要通过 Bash 调用 `scripts/recalc.py`，不要自行寻找或启动 `soffice`，也不要为了绕过重算而在 Python 中手工模拟整套 Excel 公式引擎。

**输入附件是只读的**：直接从附件绝对路径 `load_workbook()`，修改后保存到当前输出目录中的新文件名。不要用 `shutil.copy()` / `copy2()` 把附件权限原样复制后再覆盖同一文件；这会把沙箱中的只读 `0444` 一并带到副本。确需复制时使用 `shutil.copyfile()`，随后对输出文件执行 `chmod(0o600)`。

**控制单次工具输出大小**：复杂模型需要长 Python 脚本时，先用 `write` 创建短骨架，再用多次 `edit` 分段补充。不要在一次 `write` 中发送整个大型数据字典和脚本；工具参数被输出 token 上限截断后不会执行。

当工作簿包含需要求值的公式、或正式交付依赖计算后的单元格值时：
1. 先保存候选 XLSX，并做公式文本、关键输入值、工作表结构和修改范围的静态检查。
2. 调用 `finalize_deliverable`；产品会在沙箱外自动执行 Spreadsheet Runtime 的重算、错误扫描与渲染验证。
3. 只有当 `finalize_deliverable` 明确返回 `recalc_unavailable` 时，才停止公式型交付并报告阻塞；不要在调用前猜测运行时不可用。
4. 静态只读分析可以在无 LibreOffice 时进行，但必须说明公式缓存可能过期。

Skill 只描述何时需要重算与如何验证结果；Runtime 安装与探测不属于本 skill。
---

## 读取和分析数据

### 使用 pandas 进行数据分析
对于数据分析、可视化和基本操作，使用 **pandas**，它提供强大的数据操作能力：

```python
import pandas as pd

# 读取 Excel
df = pd.read_excel('file.xlsx')  # 默认：第一个工作表
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # 所有工作表以字典形式返回

# 分析
df.head()      # 预览数据
df.info()      # 列信息
df.describe()  # 统计信息

# 写入 Excel
df.to_excel('output.xlsx', index=False)
```

---

## Excel 文件工作流程

## 关键：使用公式，而非硬编码值

**始终使用 Excel 公式，而不是在 Python 中计算并硬编码结果。** 这确保电子表格保持动态和可更新。

### ❌ 错误做法 - 硬编码计算值
```python
# 错误：在 Python 中计算并硬编码结果
total = df['Sales'].sum()
sheet['B10'] = total  # 硬编码为 5000

# 错误：在 Python 中计算增长率
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # 硬编码为 0.15

# 错误：在 Python 中计算平均值
avg = sum(values) / len(values)
sheet['D20'] = avg  # 硬编码为 42.5
```

### ✅ 正确做法 - 使用 Excel 公式
```python
# 正确：让 Excel 计算总和
sheet['B10'] = '=SUM(B2:B9)'

# 正确：增长率用 Excel 公式
sheet['C5'] = '=(C4-C2)/C2'

# 正确：使用 Excel 函数求平均值
sheet['D20'] = '=AVERAGE(D2:D19)'
```

这适用于所有计算——合计、百分比、比率、差值等。电子表格应该能够在源数据变化时重新计算。

---

## 常用工作流程
1. **选择工具**：数据操作用 pandas，公式/格式化用 openpyxl
2. **创建/加载**：创建新工作簿或加载现有文件
3. **修改**：添加/编辑数据、公式和格式
4. **保存**：写入文件
5. **重算公式（如果使用了公式则为强制步骤）**：调用产品 Spreadsheet Runtime `recalc`（不要用 Bash / 临时 pip / 直接 `soffice`）
6. **验证并修复任何错误**：
   - Runtime 返回包含错误详情的结果
   - 如果发现 `#REF!` / `#DIV/0!` / `#VALUE!` / `#NAME?` 等，修复后再次重算
   - 需要修复的常见错误：
     - `#REF!`：无效的单元格引用
     - `#DIV/0!`：除以零
     - `#VALUE!`：公式中数据类型错误
     - `#NAME?`：无法识别的公式名称

---

### 创建新的 Excel 文件

```python
# 使用 openpyxl 处理公式和格式
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

# 添加数据
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# 添加公式
sheet['B2'] = '=SUM(A1:A10)'

# 格式化
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# 列宽
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

---

### 编辑现有的 Excel 文件

```python
# 使用 openpyxl 保留公式和格式
from openpyxl import load_workbook

# 加载现有文件
wb = load_workbook('existing.xlsx')
sheet = wb.active  # 或使用 wb['SheetName'] 指定工作表

# 处理多个工作表
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"工作表：{sheet_name}")

# 修改单元格
sheet['A1'] = '新值'
sheet.insert_rows(2)  # 在第 2 行处插入行
sheet.delete_cols(3)  # 删除第 3 列

# 添加新工作表
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = '数据'

wb.save('modified.xlsx')
```

---

## 重算公式

由 openpyxl 创建或修改的 Excel 文件包含作为字符串的公式，但没有计算后的值。保存工作簿后调用 `finalize_deliverable`，由产品 Spreadsheet Runtime 完成重算：

- Runtime 使用系统 LibreOffice，并创建独立临时 UserInstallation
- 在工作副本上重算，不原地修改用户上传文件
- 超时、非零退出、输出未更新均视为失败
- 缺 LibreOffice 时返回 `recalc_unavailable`——此时不得用 Python 硬编码结果冒充公式值

不要：
- 通过 Bash 执行 `scripts/recalc.py` 或直接调用 `soffice`
- 因为 Bash 内不能启动 LibreOffice，就认定 Excel 无法写入或交付
- 在 `finalize_deliverable` 之前手工模拟复杂公式缓存
- 在任务中临时安装公式计算库做兜底
- 在缺少重算能力时跳过并声称「已计算」

---

## 公式验证清单

确保公式正确运行的快速检查项：

### 基本验证
- [ ] **测试 2-3 个示例引用**：在构建完整模型前，验证它们是否拉取了正确的值
- [ ] **列映射**：确认 Excel 列对应正确（例如，第 64 列 = BL，而非 BK）
- [ ] **行偏移**：记住 Excel 行是从 1 开始的（DataFrame 第 5 行 = Excel 第 6 行）

### 常见陷阱
- [ ] **NaN 处理**：使用 `pd.notna()` 检查空值
- [ ] **最右侧列**：财年数据通常在第 50+ 列
- [ ] **多个匹配项**：搜索所有匹配项，而不仅仅是第一个
- [ ] **除以零**：在公式中使用 `/` 前检查分母（#DIV/0!）
- [ ] **错误的引用**：验证所有单元格引用指向预期的单元格（#REF!）
- [ ] **跨工作表引用**：使用正确的格式（Sheet1!A1）链接工作表

### 公式测试策略
- [ ] **从小处着手**：在广泛应用之前，先对 2-3 个单元格测试公式
- [ ] **验证依赖关系**：检查公式中引用的所有单元格是否存在
- [ ] **测试边界情况**：包括零、负数和非常大的值

---

### 解读重算结果
产品 Runtime 返回包含错误详情的结构，例如：
```json
{
  "status": "success",
  "total_errors": 0,
  "total_formulas": 42,
  "error_summary": {
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

---

## 最佳实践

### 库的选择
- **pandas**：最适合数据分析、批量操作和简单数据导出
- **openpyxl**：最适合复杂格式、公式和 Excel 特定功能

### 使用 openpyxl
- 单元格索引从 1 开始（row=1, column=1 对应单元格 A1）
- 使用 `data_only=True` 读取计算后的值：`load_workbook('file.xlsx', data_only=True)`
- **警告**：如果以 `data_only=True` 打开并保存，公式将被替换为值并永久丢失
- 对于大文件：读取时使用 `read_only=True`，写入时使用 `write_only=True`
- 公式被保留但不会被求值——使用产品 Spreadsheet Runtime 重算更新值

### 使用 pandas
- 指定数据类型以避免推断问题：`pd.read_excel('file.xlsx', dtype={'id': str})`
- 对于大文件，读取指定的列：`pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- 正确处理日期：`pd.read_excel('file.xlsx', parse_dates=['date_column'])`

---

## 代码风格指南
**重要提示**：在生成用于 Excel 操作的 Python 代码时：
- 编写简洁、精炼的 Python 代码，避免不必要的注释
- 避免冗长的变量名和冗余操作
- 避免不必要的 print 语句

**对于 Excel 文件本身**：
- 为包含复杂公式或重要假设的单元格添加注释
- 记录硬编码值的数据来源
- 为关键计算和模型部分添加说明
