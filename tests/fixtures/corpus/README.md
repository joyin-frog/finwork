# 解析语料库（Parse Corpus）

首批合成脏文件样本，用于 `tests/parse-corpus.test.ts` 的解析回归测试。
**全部文件为程序生成，零真实用户数据。**

## 命名规范

```
<解析器>-<症状>.<ext>
```

示例：`xlsx-offrow-header.xlsx`、`csv-gbk-encoding.csv`、`xls-legacy-format.xls`

## 样本清单

| 文件 | 解析器 | 症状/用途 |
|---|---|---|
| `xlsx-offrow-header.xlsx` | exceljs | 歪表头（数据从第 3 行开始，第 2 行才是列名） |
| `xlsx-merged-cells.xlsx` | exceljs | 合并单元格（跨行值） |
| `xlsx-multisheet-first-empty.xlsx` | exceljs | 多 sheet 且首 sheet 空，数据在第二 sheet |
| `csv-gbk-encoding.csv` | text/* | GBK 编码中文，UTF-8 读取产生 U+FFFD，触发拒绝路径 |
| `csv-alias-columns.csv` | analyze_csv | 列名别名（中文：金额/类目/发票号），不匹配英文列名 |
| `csv-thousand-sep-currency.csv` | analyze_csv | 千分位与货币符号金额，float() 解析异常 |
| `csv-unmatched-columns.csv` | analyze_csv | 列名完全不匹配，触发 column_warnings |
| `xls-legacy-format.xls` | parseDocument | 旧版 .xls 格式，触发明确拒绝路径 |
| `unknown-format.bin` | parseDocument | 未知扩展名，触发"不支持的文件类型"拒绝 |

## PII 规避规则（机器门控）

`tests/parse-corpus.test.ts` 对 corpus 全部文本可读文件自动执行 `redact(text) === text` 断言。
**凡 redact 输出与原文不一致即测试红——语料含 PII 由机器保证发现。**

生成脚本遵守的规避规则：
- 发票号统一 `INV-` 或 `VCH-` 前缀（不用纯数字）
- 金额带小数点（如 `100.00`）
- 日期带连字符（如 `2026-01-10`）
- **禁止** `1[3-9]` 开头的 11 位连续数字（手机号 PII 形态）
- **禁止** 18 位身份证号格式数字
- **禁止** 真实邮箱地址
- **禁止** 16-19 位连续数字（银行卡号形态）

## 纪律条款

1. **修解析 bug 必须先落触发样本**：在此目录新增能复现 bug 的合成样本，并在 `tests/parse-corpus.test.ts` 补红测试，修完转绿后方可合并。
2. **零真实数据**：禁止将任何真实用户文件或含真实 PII 的数据提交到此目录。
3. **生成脚本入库**：所有样本必须有对应的生成脚本存放于 `gen/` 目录，确保可再生。
4. **PII 规避优先**：新增样本前先确认不触发 `lib/safety/pii.ts` 的脱敏规则。

## 再生方式

```bash
# 生成 GBK CSV（需要 venv Python）
/path/to/.venv/bin/python3 tests/fixtures/corpus/gen/gen-gbk-csv.py

# 生成 xlsx 样本（需要 Node.js + exceljs）
node tests/fixtures/corpus/gen/gen-xlsx.mjs

# 生成其他 CSV 样本
node tests/fixtures/corpus/gen/gen-csv-samples.mjs

# 生成拒绝路径桩文件
node tests/fixtures/corpus/gen/gen-reject-stubs.mjs
```
