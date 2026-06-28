#!/usr/bin/env python3
"""reimbursement.py 的 parity 自测:把原 TS golden(tests/reimbursement-ledger.test.ts 的
T2/T3/T4 校验+排序用例)逐字搬来,断言逐项一致。由 tests/reimbursement-script.test.ts 进 CI。
(T1/T5 是 DB 台账/配置,仍由 TS 测试覆盖,不在脚本范围。)
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reimbursement import validate, sort_by_risk  # noqa: E402

fails = []


def chk(cond, msg):
    if not cond:
        fails.append(msg)


# ── T2: 跨月历史查重 ──
checked = validate(
    [
        {"employeeName": "A", "expenseDate": "2026-06-01", "invoiceNo": "INV-2026-001", "category": "交通", "amount": 320},
        {"employeeName": "B", "expenseDate": "2026-06-02", "invoiceNo": "INV-2026-999", "category": "餐饮", "amount": 80},
    ],
    {"singleLimit": 1500},
    {"INV-2026-001": {"recordedAt": "2026-05-12 08:30:00"}},
)
dup = next((w for w in checked[0]["warnings"] if w.startswith("历史重复")), None)
chk(dup is not None and re.match(r"历史重复\(\d{4}-\d{2} 已登记\)", dup), f"T2 历史重复警告: {checked[0]['warnings']}")
chk(checked[1]["warnings"] == [], f"T2 未登记不应误报: {checked[1]['warnings']}")

# ── T3: 批内重复 + 缺类目 + 超标 ──
batch = validate(
    [
        {"employeeName": "A", "expenseDate": "2026-05-01", "invoiceNo": "INV-1", "category": "交通", "amount": 100},
        {"employeeName": "B", "expenseDate": "2026-05-02", "invoiceNo": "INV-1", "category": "", "amount": 2000},
    ],
    {"singleLimit": 1500},
    {},
)
chk(batch[0]["warnings"] == ["发票号重复"], f"T3 batch[0]: {batch[0]['warnings']}")
chk(batch[1]["warnings"] == ["缺少类目", "超过单笔标准", "发票号重复"], f"T3 batch[1]: {batch[1]['warnings']}")

# ── T4: 风险排序 ──
sorted_items = sort_by_risk([
    {"employeeName": "干净", "warnings": []},
    {"employeeName": "缺类目", "warnings": ["缺少类目"]},
    {"employeeName": "超标", "warnings": ["超过单笔标准"]},
    {"employeeName": "历史", "warnings": ["历史重复(2026-05 已登记)"]},
    {"employeeName": "批内", "warnings": ["发票号重复"]},
])
order = [i["employeeName"] for i in sorted_items]
chk(order == ["历史", "批内", "超标", "缺类目", "干净"], f"T4 排序: {order}")

if fails:
    print("FAIL:\n" + "\n".join(fails))
    sys.exit(1)
print("PASS: reimbursement.py parity — T2/T3/T4 校验与排序逐项一致")
