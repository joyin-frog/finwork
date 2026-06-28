#!/usr/bin/env python3
"""工资薪金个税:累计预扣预缴法(payroll-calc skill 固定脚本,确定性引擎)。

本期应预扣 = max(0, 累计应纳税额 − 累计已预扣)。算法在本脚本(你可直接调),政策数字
(税率档/基本减除)默认见 DEFAULT_CONFIG,但**生产由 calculate_payroll_batch 工具把
loadTaxConfig() 的运行期配置传进来**(app_settings 覆盖照样生效);DB 接力/草稿落库/确认门/
审计仍在 TS 工具侧(红线 5/8)。

口径(与原 TS 引擎逐分一致,见 selftest_payroll.py 的 parity 用例):
- 舍入"逐步到分":每个累计量各自 round2,再算累计应纳税所得额/应预扣/本期应预扣。
- round2 = JS Math.round(半数进位),用 floor(x*100+0.5)/100 复刻(非 Python 银行家舍入)。
- 档位归属 `累计应纳税所得额 <= 档位上限`,临界归低档。

用法:`echo '{"config":{...},"items":[{...}]}' | python3 payroll.py`  → stdout JSON {results:[...]}。
"""
import sys
import json
import math

DEFAULT_CONFIG = {
    "version": "2026-standard-v1",
    "effectiveYear": 2026,
    "basicDeductionMonthly": 5000,
    "brackets": [
        {"limit": 36000, "rate": 0.03, "quickDeduction": 0},
        {"limit": 144000, "rate": 0.1, "quickDeduction": 2520},
        {"limit": 300000, "rate": 0.2, "quickDeduction": 16920},
        {"limit": 420000, "rate": 0.25, "quickDeduction": 31920},
        {"limit": 660000, "rate": 0.3, "quickDeduction": 52920},
        {"limit": 960000, "rate": 0.35, "quickDeduction": 85920},
        {"limit": float("inf"), "rate": 0.45, "quickDeduction": 181920},
    ],
}

ZERO_PRIOR = {"grossCum": 0, "socialCum": 0, "fundCum": 0, "specialCum": 0, "taxWithheldCum": 0}


def round2(v):
    # JS Math.round(v*100)/100:半数进位(非 Python 银行家舍入)
    return math.floor(v * 100 + 0.5) / 100


def fmt(v):
    return f"{v:.2f}"


def _bracket_limit(b):
    lim = b["limit"]
    return float("inf") if lim is None or lim == "Infinity" else float(lim)


def validate(item):
    name = item.get("employeeName", "?")
    m = item.get("monthsEmployed")
    if not isinstance(m, int) or isinstance(m, bool) or m < 1 or m > 12:
        raise ValueError(f"{name}:任职月数必须是 1-12 的整数,实际为 {m}")
    pairs = [
        ("税前工资", item.get("grossPay")),
        ("五险个人部分", item.get("socialInsurance")),
        ("公积金个人部分", item.get("housingFund")),
        ("专项附加扣除", item.get("specialDeduction")),
    ]
    prior = item.get("prior")
    if prior:
        pairs += [
            ("累计收入", prior.get("grossCum")),
            ("累计五险", prior.get("socialCum")),
            ("累计公积金", prior.get("fundCum")),
            ("累计专项附加", prior.get("specialCum")),
            ("累计已预扣税额", prior.get("taxWithheldCum")),
        ]
        if prior.get("taxWithheldCum", 0) > prior.get("grossCum", 0):
            raise ValueError(
                f"{name}:累计已预扣税额 {fmt(prior['taxWithheldCum'])} 大于累计收入 "
                f"{fmt(prior['grossCum'])},请核对扣缴端累计数"
            )
    for label, val in pairs:
        if not isinstance(val, (int, float)) or isinstance(val, bool) or not math.isfinite(val) or val < 0:
            raise ValueError(f"{name}:{label}不能为负数或非数值,实际为 {val}")


def calculate(item, config):
    validate(item)
    prior = item.get("prior") or ZERO_PRIOR
    basic = config["basicDeductionMonthly"]

    gross_cum = round2(prior["grossCum"] + item["grossPay"])
    social_cum = round2(prior["socialCum"] + item["socialInsurance"])
    fund_cum = round2(prior["fundCum"] + item["housingFund"])
    special_cum = round2(prior["specialCum"] + item["specialDeduction"])
    basic_cum = round2(basic * item["monthsEmployed"])

    taxable_cum = max(0, round2(gross_cum - basic_cum - social_cum - fund_cum - special_cum))
    bracket = next((b for b in config["brackets"] if taxable_cum <= _bracket_limit(b)), config["brackets"][-1])
    tax_due_cum = max(0, round2(taxable_cum * bracket["rate"] - bracket["quickDeduction"]))
    tax_current = max(0, round2(tax_due_cum - prior["taxWithheldCum"]))
    net_pay = round2(item["grossPay"] - item["socialInsurance"] - item["housingFund"] - tax_current)

    rate_pct = f"{round(bracket['rate'] * 100)}"
    formula = ";".join([
        f"累计应纳税所得额 {fmt(taxable_cum)} = 累计收入 {fmt(gross_cum)} − 基本减除 "
        f"{fmt(basic_cum)}({fmt(basic)}×{item['monthsEmployed']}月) − 专项扣除 "
        f"{fmt(round2(social_cum + fund_cum))} − 专项附加 {fmt(special_cum)}",
        f"适用税率档 {rate_pct}%:累计应预扣 {fmt(tax_due_cum)} = {fmt(taxable_cum)} × "
        f"{rate_pct}% − 速算扣除 {fmt(bracket['quickDeduction'])}",
        f"本期应预扣 {fmt(tax_current)} = max(0, {fmt(tax_due_cum)} − 累计已预扣 {fmt(prior['taxWithheldCum'])})",
    ])

    return {
        "employeeName": item["employeeName"],
        "grossPay": item["grossPay"],
        "socialInsurance": item["socialInsurance"],
        "housingFund": item["housingFund"],
        "specialDeduction": item["specialDeduction"],
        "taxCurrent": tax_current,
        "netPay": net_pay,
        "taxWithheldCum": round2(prior["taxWithheldCum"] + tax_current),
        "detail": {
            "grossCum": gross_cum,
            "basicDeductionCum": basic_cum,
            "socialCum": social_cum,
            "fundCum": fund_cum,
            "specialCum": special_cum,
            "taxableIncomeCum": taxable_cum,
            "bracketRate": bracket["rate"],
            "quickDeduction": bracket["quickDeduction"],
            "taxDueCum": tax_due_cum,
            "taxWithheldPriorCum": prior["taxWithheldCum"],
            "formula": formula,
            "taxConfigVersion": config["version"],
        },
    }


def run(payload):
    config = payload.get("config") or DEFAULT_CONFIG
    out = []
    for item in payload.get("items", []):
        try:
            out.append({"ok": True, "result": calculate(item, config)})
        except ValueError as e:
            out.append({"ok": False, "employeeName": item.get("employeeName", "?"), "error": str(e)})
    return {"results": out}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"输入解析失败: {e}"}, ensure_ascii=False))
        sys.exit(2)
    print(json.dumps(run(payload), ensure_ascii=False))


if __name__ == "__main__":
    main()
