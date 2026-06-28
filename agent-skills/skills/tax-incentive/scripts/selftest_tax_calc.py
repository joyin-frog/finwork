#!/usr/bin/env python3
"""tax_calc.py 的自测:VAT/CIT 在干净 golden 用例上的税额与口径(原 TS 工具无独立测试,
本测试新建,按法定公式钉住计算结果)。由 tests/tax-calc-script.test.ts 进 CI。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tax_calc import vat, cit  # noqa: E402

fails = []


def chk(cond, msg):
    if not cond:
        fails.append(msg)


# VAT 不含税→含税
t = vat(1000, {"direction": "from_tax_exclusive", "rate": "0.13"})
chk("税额：1000.00 x 13% = 130.00 元" in t and "含税金额：1130.00 元" in t, f"VAT 不含税: {t}")
# VAT 含进项
t = vat(1000, {"direction": "from_tax_exclusive", "rate": "0.13", "inputTax": 30})
chk("应纳增值税：130.00 - 30.00（进项）= 100.00 元" in t, f"VAT 进项: {t}")
# VAT 含税分离
t = vat(1130, {"direction": "from_tax_inclusive", "rate": "0.13"})
chk("= 130.00 元" in t and "不含税金额：1000.00 元" in t, f"VAT 含税分离: {t}")
# CIT 普通
t = cit(1000000, {"rate": "0.25", "deductions": 0})
chk("应纳税额：1000000.00 x 25% = 250000.00 元" in t and "税后利润：750000.00 元" in t, f"CIT: {t}")
# CIT 带扣除
t = cit(1000000, {"rate": "0.20", "deductions": 200000})
chk("应纳税所得额：800000.00 元" in t and "= 160000.00 元" in t, f"CIT 扣除: {t}")
# CIT 应纳税所得额为负 → 税额取 0
t = cit(100, {"rate": "0.25", "deductions": 200})
chk("应纳税额：-100.00 x 25% = 0.00 元" in t, f"CIT 负所得→0: {t}")

if fails:
    print("FAIL:\n" + "\n".join(fails))
    sys.exit(1)
print("PASS: tax_calc.py — VAT/CIT 法定税率直算结果钉住")
