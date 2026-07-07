# audit-parse-corpus.md

WP11：脏文件语料库 + GBK 编码检测 + PII 门控 + analyze-csv column_warnings

## Files changed

| 文件 | 动作 |
|---|---|
| `tests/fixtures/corpus/csv-gbk-encoding.csv` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/csv-alias-columns.csv` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/csv-thousand-sep-currency.csv` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/csv-unmatched-columns.csv` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/xlsx-offrow-header.xlsx` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/xlsx-merged-cells.xlsx` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/xlsx-multisheet-first-empty.xlsx` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/xls-legacy-format.xls` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/unknown-format.bin` | 新增（gen 脚本生成） |
| `tests/fixtures/corpus/README.md` | 新增 |
| `tests/fixtures/corpus/gen/gen-gbk-csv.py` | 新增 |
| `tests/fixtures/corpus/gen/gen-xlsx.mjs` | 新增 |
| `tests/fixtures/corpus/gen/gen-csv-samples.mjs` | 新增 |
| `tests/fixtures/corpus/gen/gen-reject-stubs.mjs` | 新增 |
| `tests/parse-corpus.test.ts` | 新增 |
| `lib/knowledge/parsers/index.ts` | 修改（text/* 分支 U+FFFD 检测） |
| `workers/finance_worker.py` | 修改（analyze_csv 加 column_warnings） |
| `.gitattributes` | 新增 |
| `tests/all.test.ts` | 修改（末尾追加 parseCorpusTestPromise） |

## 各文件改动内容

### tests/fixtures/corpus/（目录）
- 9 个合成样本（xlsx×3、csv×4、xls×1、bin×1）
- 4 个生成脚本入 gen/ 目录
- README.md 记录命名规范、纪律条款、PII 规避规则、再生方式

### tests/parse-corpus.test.ts
- Section A（xlsx×3）：buildSpreadsheetMirror 回归锚点——验证工作表名、关键数据存在
- Section B（拒绝路径×3）：GBK csv 断言抛出且含"编码"（TDD-红→绿）；xls 断言含"不支持"（回归锚点）；bin 断言含"不支持"（回归锚点）
- Section C（analyze_csv×3）：alias-columns 总金额=0 回归锚点；unmatched-columns column_warnings 非空（TDD-红→绿）；thousand-sep-currency worker 报错退出（回归锚点）
- Section D：PII 门控——遍历 corpus 所有文本类文件（9 个），redact(text) === text

### lib/knowledge/parsers/index.ts
- `parseDocument` text/* 分支：`readFileSync` 读取后检测 `content.includes("＊")` 含 U+FFFD（`"＊"` 即替换符），抛出"文件编码可能不是 UTF-8（常见为 GBK），请用 Excel/记事本另存为 UTF-8 后重传。"
- 改动范围：仅 text/* 分支，4 行插入，其他逻辑不变

### workers/finance_worker.py
- `analyze_csv` 函数：读取 `reader.fieldnames` 后检测 `amount`/`category`/`invoice_no` 三列是否存在，不存在则追加 `column_warnings` 条目（"未找到 X 列（y），已识别列：<实际列名>"）
- 返回值增加 `column_warnings: list[str]` 字段；原有 `row_count`、`by_category`、`warnings` 不变
- 改动范围：仅 analyze_csv 函数，约 14 行插入

### .gitattributes（新增）
- `tests/fixtures/corpus/** -text`：禁 git 对该目录内文件做换行转换，保护 GBK 字节和二进制样本

### tests/all.test.ts
- 末尾追加 `parseCorpusTestPromise` import 和 await（2 行）
- 注意：另一代理（WP8c）已在此文件末尾追加了 `receivablesLiveTestPromise`，本次追加在其后

## 与计划的偏差

1. **all.test.ts 追加位置**：spec 说"末尾追加"，实际追加在 WP8c 代理新增的 `receivablesLiveTestPromise` 之后（而非原文件末尾）。这是因为 WP8c 并行运行已修改了该文件。追加仍在末尾，符合意图。

2. **xlsx-offrow-header 断言调整**：初版断言检查 INV 号，但 buildSpreadsheetMirror 把第 1 行（标题区）当表头，INV 号落在第 2 列却只有 1 列表头，导致发票号不在输出中。改为断言"金额"出现（第 2 行列名被当作数据，记录歪表头症状）和数值出现（100/250）。这更准确地记录了歪表头的实际症状，比断言不存在的数据更有价值。

3. **tests/python-worker.test.ts 无需修改**：既有断言只检查 `row_count` 和 `by_category.A`，不涉及 `column_warnings`，无需同步。

## 红→绿证据

**GBK 编码检测（TDD-红→绿）：**
- 修复前：`parseDocument("text/csv", gbk_file)` 直接返回乱码字符串，`threw = false`，断言"应抛出错误"红
- 修复后：检测到 U+FFFD 抛出"文件编码可能不是 UTF-8…"，断言绿

**column_warnings（TDD-红→绿）：**
- 修复前：`analyze_csv(unmatched_columns)` 无 `column_warnings` 字段，`result.column_warnings` 为 `undefined`，`Array.isArray(undefined)` 为 false，断言红
- 修复后：返回 `column_warnings: ["未找到金额列（amount）…", "未找到类目列…", "未找到发票号列…"]`，断言绿

## 测试结果

```
全量：EXIT=0，零 unhandledRejection
typecheck：EXIT=0
lint：EXIT=0（139 pre-existing warnings，0 errors，本次改动无新 warning）
```

## 开放风险

1. **csv-thousand-sep-currency 的行为**：当前 analyze_csv 对货币符号金额直接 float() 报错。测试用"worker 应报错退出"作为锚点，不是修复。修复（清洗货币符号）是后续工作。
2. **xlsx-offrow-header 症状锚点**：歪表头解析输出不正确（第 2 行列名被当作数据），测试仅记录现状，未修复。修复需要表头行检测，是独立任务。
3. **PII 门控覆盖 gen 脚本**：目前 PII 门控读取 gen/ 目录下所有 .py/.mjs 文件，这些是生成脚本，含字面量数据。若未来脚本中出现类手机号字面量会触发红。规避规则已写入 README.md。
