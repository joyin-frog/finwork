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


def ff(v):
    """Float rounded to 2 decimal places — same rounding as f2 text output.
    Ensures structured result.value and the human-readable text agree exactly."""
    return float(f"{v:.2f}")


def pct(rate):
    return f"{round(rate * 100)}"


def vat(amount, p):
    rate = float(p["rate"])
    direction = p["direction"]
    input_tax = p.get("inputTax")
    if direction == "from_tax_exclusive":
        tax = amount * rate
        inclusive = amount + tax
        tax_v = ff(tax)
        incl_v = ff(inclusive)
        lines = [
            "《增值税计算 - 不含税到含税》",
            f"不含税金额：{f2(amount)} 元",
            f"税率：{pct(rate)}%",
            f"税额：{f2(amount)} x {pct(rate)}% = {f2(tax)} 元",
            f"含税金额：{f2(inclusive)} 元",
        ]
        steps = [
            {"label": "税额", "expr": f"amount × {pct(rate)}%", "subtotal": tax_v},
            {"label": "含税金额", "expr": "amount + tax", "subtotal": incl_v},
        ]
        value = tax_v
        if input_tax is not None:
            net = tax - input_tax
            lines.append(f"应纳增值税：{f2(tax)} - {f2(input_tax)}（进项）= {f2(net)} 元")
            net_v = ff(max(net, 0))
            steps.append({"label": "应纳增值税", "expr": "tax - inputTax", "subtotal": net_v})
            value = net_v
        return {"text": "\n".join(lines), "result": {"value": value, "caliberVersion": f"vat-{p['rate']}", "steps": steps}}
    tax = (amount * rate) / (1 + rate)
    exclusive = amount - tax
    tax_v = ff(tax)
    excl_v = ff(exclusive)
    text = "\n".join([
        "《增值税计算 - 含税分离税额》",
        f"含税金额：{f2(amount)} 元",
        f"税率：{pct(rate)}%",
        f"税额：{f2(amount)} / (1 + {pct(rate)}%) x {pct(rate)}% = {f2(tax)} 元",
        f"不含税金额：{f2(exclusive)} 元",
    ])
    return {
        "text": text,
        "result": {
            "value": tax_v,
            "caliberVersion": f"vat-{p['rate']}",
            "steps": [
                {"label": "税额", "expr": f"amount × {pct(rate)}% / (1 + {pct(rate)}%)", "subtotal": tax_v},
                {"label": "不含税金额", "expr": "amount - tax", "subtotal": excl_v},
            ],
        }
    }


def cit(amount, p):
    rate = float(p["rate"])
    deductions = p.get("deductions") or 0
    taxable = amount - deductions
    tax = max(taxable * rate, 0)
    taxable_v = ff(taxable)
    tax_v = ff(tax)
    text = "\n".join([
        "《企业所得税计算》",
        f"利润总额：{f2(amount)} 元",
        f"税前扣除：{f2(deductions)} 元",
        f"应纳税所得额：{f2(taxable)} 元",
        f"适用税率：{pct(rate)}%",
        f"应纳税额：{f2(taxable)} x {pct(rate)}% = {f2(tax)} 元",
        f"税后利润：{f2(amount - tax)} 元",
    ])
    return {
        "text": text,
        "result": {
            "value": tax_v,
            "caliberVersion": f"cit-{p['rate']}",
            "steps": [
                {"label": "应纳税所得额", "expr": "amount - deductions", "subtotal": taxable_v},
                {"label": "应纳税额", "expr": f"taxableIncome × {pct(rate)}%", "subtotal": tax_v},
            ],
        }
    }


def run(p):
    t = p.get("type")
    if t == "vat" and p.get("vatParams"):
        return vat(p["amount"], p["vatParams"])  # vat() 已返回 {text, result}，直接透传
    if t == "cit" and p.get("citParams"):
        return cit(p["amount"], p["citParams"])  # cit() 已返回 {text, result}，直接透传
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
