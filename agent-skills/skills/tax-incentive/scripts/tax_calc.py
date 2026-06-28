#!/usr/bin/env python3
"""增值税 / 企业所得税计算(确定性;含完整计算过程文本便于对账审计)。

工资薪金个税不在此(走 payroll.py 累计预扣预缴)。税率为法定档(调用方按当年政策选),
小微/高新等实际优惠税负逐年调整,本脚本按所选法定税率直算。parity 见 selftest_tax_calc.py。
用法:`echo '{"type":"vat","amount":1000,"vatParams":{"direction":"from_tax_exclusive","rate":"0.13"}}' | python3 tax_calc.py`
"""
import sys
import json


def f2(v):
    return f"{v:.2f}"


def pct(rate):
    return f"{round(rate * 100)}"


def vat(amount, p):
    rate = float(p["rate"])
    direction = p["direction"]
    input_tax = p.get("inputTax")
    if direction == "from_tax_exclusive":
        tax = amount * rate
        inclusive = amount + tax
        lines = [
            "【增值税计算 - 不含税到含税】",
            f"不含税金额：{f2(amount)} 元",
            f"税率：{pct(rate)}%",
            f"税额：{f2(amount)} x {pct(rate)}% = {f2(tax)} 元",
            f"含税金额：{f2(inclusive)} 元",
        ]
        if input_tax is not None:
            lines.append(f"应纳增值税：{f2(tax)} - {f2(input_tax)}（进项）= {f2(tax - input_tax)} 元")
        return "\n".join(lines)
    tax = (amount * rate) / (1 + rate)
    exclusive = amount - tax
    return "\n".join([
        "【增值税计算 - 含税分离税额】",
        f"含税金额：{f2(amount)} 元",
        f"税率：{pct(rate)}%",
        f"税额：{f2(amount)} / (1 + {pct(rate)}%) x {pct(rate)}% = {f2(tax)} 元",
        f"不含税金额：{f2(exclusive)} 元",
    ])


def cit(amount, p):
    rate = float(p["rate"])
    deductions = p.get("deductions") or 0
    taxable = amount - deductions
    tax = max(taxable * rate, 0)
    return "\n".join([
        "【企业所得税计算】",
        f"利润总额：{f2(amount)} 元",
        f"税前扣除：{f2(deductions)} 元",
        f"应纳税所得额：{f2(taxable)} 元",
        f"适用税率：{pct(rate)}%",
        f"应纳税额：{f2(taxable)} x {pct(rate)}% = {f2(tax)} 元",
        f"税后利润：{f2(amount - tax)} 元",
    ])


def run(p):
    t = p.get("type")
    if t == "vat" and p.get("vatParams"):
        return {"text": vat(p["amount"], p["vatParams"])}
    if t == "cit" and p.get("citParams"):
        return {"text": cit(p["amount"], p["citParams"])}
    return {"text": "参数不完整，请提供对应税种的计算参数。"}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"text": f"输入解析失败: {e}"}, ensure_ascii=False))
        sys.exit(2)
    print(json.dumps(run(payload), ensure_ascii=False))


if __name__ == "__main__":
    main()
