#!/usr/bin/env python3
"""生成 GBK 编码的 CSV 语料样本（corpus/csv-gbk-encoding.csv）。

运行方式（在仓库根目录）：
    python tests/fixtures/corpus/gen/gen-gbk-csv.py

PII 规避：发票号 INV- 前缀；金额带小数点；日期带连字符；禁 1[3-9] 开头 11 位数字。
"""
import pathlib

OUT = pathlib.Path(__file__).parent.parent / "csv-gbk-encoding.csv"

# GBK 编码内容（含中文汉字）
content = "金额,类目,发票号,日期\n100.00,办公用品,INV-2026-001,2026-01-10\n250.50,交通费,INV-2026-002,2026-01-15\n"
OUT.write_bytes(content.encode("gbk"))
print(f"已生成：{OUT}")
