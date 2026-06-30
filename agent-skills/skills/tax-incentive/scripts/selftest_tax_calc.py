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
r = vat(1000, {"direction": "from_tax_exclusive", "rate": "0.13"})
chk("税额：1000.00 x 13% = 130.00 元" in r["text"] and "含税金额：1130.00 元" in r["text"], f"VAT 不含税 text: {r['text']}")
chk(r["result"]["value"] == 130.0, f"VAT 不含税 result.value: {r['result']['value']}")
chk(r["result"]["steps"][0]["subtotal"] == 130.0, f"VAT 不含税 steps[0].subtotal: {r['result']['steps'][0]['subtotal']}")
chk(r["result"]["caliberVersion"] == "vat-0.13", f"VAT caliberVersion: {r['result']['caliberVersion']}")
# VAT 含进项
r = vat(1000, {"direction": "from_tax_exclusive", "rate": "0.13", "inputTax": 30})
chk("应纳增值税：130.00 - 30.00（进项）= 100.00 元" in r["text"], f"VAT 进项 text: {r['text']}")
chk(r["result"]["value"] == 100.0, f"VAT 进项 result.value: {r['result']['value']}")
# VAT 含税分离
r = vat(1130, {"direction": "from_tax_inclusive", "rate": "0.13"})
chk("= 130.00 元" in r["text"] and "不含税金额：1000.00 元" in r["text"], f"VAT 含税分离 text: {r['text']}")
chk(r["result"]["value"] == 130.0, f"VAT 含税分离 result.value: {r['result']['value']}")
# CIT 普通
r = cit(1000000, {"rate": "0.25", "deductions": 0})
chk("应纳税额：1000000.00 x 25% = 250000.00 元" in r["text"] and "税后利润：750000.00 元" in r["text"], f"CIT text: {r['text']}")
chk(r["result"]["value"] == 250000.0, f"CIT result.value: {r['result']['value']}")
chk(r["result"]["caliberVersion"] == "cit-0.25", f"CIT caliberVersion: {r['result']['caliberVersion']}")
# CIT 带扣除
r = cit(1000000, {"rate": "0.20", "deductions": 200000})
chk("应纳税所得额：800000.00 元" in r["text"] and "= 160000.00 元" in r["text"], f"CIT 扣除 text: {r['text']}")
chk(r["result"]["value"] == 160000.0, f"CIT 扣除 result.value: {r['result']['value']}")
# CIT 应纳税所得额为负 → 税额取 0
r = cit(100, {"rate": "0.25", "deductions": 200})
chk("应纳税额：-100.00 x 25% = 0.00 元" in r["text"], f"CIT 负所得→0 text: {r['text']}")
chk(r["result"]["value"] == 0.0, f"CIT 负所得 result.value: {r['result']['value']}")

if fails:
    print("FAIL:\n" + "\n".join(fails))
    sys.exit(1)
print("PASS: tax_calc.py — VAT/CIT 法定税率直算结果钉住")
