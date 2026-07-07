#!/usr/bin/env node
/**
 * 生成四个 CSV 语料样本（非 GBK 的三个，GBK 由 gen-gbk-csv.py 生成）：
 *   corpus/csv-alias-columns.csv         — 列名别名（金额/类目/发票号，非标准英文列名）
 *   corpus/csv-thousand-sep-currency.csv  — 千分位与货币符号金额（analyze_csv 无法解析）
 *   corpus/csv-unmatched-columns.csv     — 列名完全不匹配（触发 column_warnings）
 *
 * 运行方式（在仓库根目录）：
 *   node tests/fixtures/corpus/gen/gen-csv-samples.mjs
 *
 * PII 规避：发票号 INV- 前缀；金额带小数点；日期带连字符；禁 1[3-9] 开头 11 位数字。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..");

// csv-alias-columns: 列名别名（中文列名，不是 amount/category/invoice_no）
writeFileSync(
  path.join(OUT, "csv-alias-columns.csv"),
  "金额,类目,发票号\n100.00,办公用品,INV-2026-031\n250.50,交通费,INV-2026-032\n",
  "utf-8"
);
console.log("已生成：csv-alias-columns.csv");

// csv-thousand-sep-currency: 千分位与货币符号金额（analyze_csv float() 会报错）
writeFileSync(
  path.join(OUT, "csv-thousand-sep-currency.csv"),
  "amount,category,invoice_no\n\"¥1,200.50\",办公用品,INV-2026-041\n\"$3,450.00\",招待费,INV-2026-042\n",
  "utf-8"
);
console.log("已生成：csv-thousand-sep-currency.csv");

// csv-unmatched-columns: 列名完全不匹配（触发 column_warnings）
writeFileSync(
  path.join(OUT, "csv-unmatched-columns.csv"),
  "费用金额,费用类别,凭证编号\n500.00,交通,VCH-2026-001\n300.00,餐饮,VCH-2026-002\n",
  "utf-8"
);
console.log("已生成：csv-unmatched-columns.csv");

console.log("全部 CSV 样本已生成。");
