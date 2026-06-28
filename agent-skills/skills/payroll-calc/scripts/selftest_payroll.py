#!/usr/bin/env python3
"""payroll.py 的 **parity 自测**:把原 TS 引擎 tests/tax-cumulative.test.ts 的 T1-T7 golden
用例逐字搬来,断言脚本输出与原引擎**逐分一致**——这是"把核心算数从 TS 迁到脚本、零回归"的证据。
由 tests/payroll-script.test.ts 经 venv python 跑进 CI。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from payroll import calculate, DEFAULT_CONFIG, ZERO_PRIOR  # noqa: E402

fails = []


def chk(cond, msg):
    if not cond:
        fails.append(msg)


def emp(name, gross, social, fund, special, months, prior=None):
    d = {"employeeName": name, "grossPay": gross, "socialInsurance": social,
         "housingFund": fund, "specialDeduction": special, "monthsEmployed": months}
    if prior is not None:
        d["prior"] = prior
    return d


def carry(r):
    d = r["detail"]
    return {"grossCum": d["grossCum"], "socialCum": d["socialCum"], "fundCum": d["fundCum"],
            "specialCum": d["specialCum"], "taxWithheldCum": r["taxWithheldCum"]}


def throws(fn, frag):
    try:
        fn()
        return False
    except ValueError as e:
        return frag in str(e)


# ── T1: golden 12 月序列 ──
golden = [555, 625, 1850, 1850, 1850, 1850, 1850, 2250, 3700, 3700, 3700, 3700]
prior = dict(ZERO_PRIOR)
for month in range(1, 13):
    r = calculate(emp("甲", 30000, 4500, 0, 2000, month, prior), DEFAULT_CONFIG)
    chk(r["taxCurrent"] == golden[month - 1], f"T1 {month}月 税额 {r['taxCurrent']} 期望 {golden[month-1]}")
    chk(r["netPay"] == 30000 - 4500 - golden[month - 1], f"T1 {month}月 实发 {r['netPay']}")
    prior = carry(r)
chk(prior["taxWithheldCum"] == 27480, f"T1 全年累计 {prior['taxWithheldCum']} 期望 27480")

# ── T2: 本期为负→预扣 0,不退税 ──
t2m1 = calculate(emp("乙", 30000, 4500, 0, 2000, 1), DEFAULT_CONFIG)
chk(t2m1["taxCurrent"] == 555, "T2 m1=555")
t2m2 = calculate(emp("乙", 3000, 4500, 0, 2000, 2, {"grossCum": 30000, "socialCum": 4500, "fundCum": 0, "specialCum": 2000, "taxWithheldCum": 555}), DEFAULT_CONFIG)
chk(t2m2["taxCurrent"] == 0, "T2 本期负→0")
chk(t2m2["taxWithheldCum"] == 555, "T2 累计不减")

# ── T3: 年中入职 ──
p3 = dict(ZERO_PRIOR)
for idx, exp in enumerate([330, 330, 330, 890]):
    r = calculate(emp("丙", 20000, 3000, 0, 1000, idx + 1, p3), DEFAULT_CONFIG)
    chk(r["taxCurrent"] == exp, f"T3 第{idx+1}月 {r['taxCurrent']} 期望 {exp}")
    p3 = carry(r)

# ── T4: 换配置(减除 6000)结果随之变,带版本 ──
cfg2 = {**DEFAULT_CONFIG, "version": "test-v2", "basicDeductionMonthly": 6000}
t4 = calculate(emp("丁", 30000, 4500, 0, 2000, 1), cfg2)
chk(t4["detail"]["taxConfigVersion"] == "test-v2", "T4 版本")
chk(t4["taxCurrent"] == 525, f"T4 {t4['taxCurrent']} 期望 525")

# ── T5: 明细可追溯 ──
chk(t2m1["detail"]["bracketRate"] == 0.03, "T5 bracketRate")
chk(t2m1["detail"]["taxableIncomeCum"] == 18500, "T5 taxableIncomeCum")
chk("适用税率档 3%" in t2m1["detail"]["formula"], "T5 公式税率档")
chk("速算扣除" in t2m1["detail"]["formula"], "T5 公式速算")
chk("累计已预扣" in t2m1["detail"]["formula"], "T5 公式累计")

# ── T6: 输入校验显式报错 ──
chk(throws(lambda: calculate(emp("戊", -1, 0, 0, 0, 1), DEFAULT_CONFIG), "不能为负数"), "T6 负工资报错")
chk(throws(lambda: calculate(emp("戊", 10000, 0, 0, 0, 0), DEFAULT_CONFIG), "任职月数"), "T6 月数0报错")
chk(throws(lambda: calculate(emp("戊", 10000, 0, 0, 0, 2, {"grossCum": 1000, "socialCum": 0, "fundCum": 0, "specialCum": 0, "taxWithheldCum": 2000}), DEFAULT_CONFIG), "请核对扣缴端累计数"), "T6 累计>收入报错")

# ── T7: 档位临界 / 最高档 / 纯 0 税 ──
t7a = calculate(emp("临界", 41000, 0, 0, 0, 1), DEFAULT_CONFIG)
chk(t7a["detail"]["taxableIncomeCum"] == 36000 and t7a["detail"]["bracketRate"] == 0.03 and t7a["taxCurrent"] == 1080 and t7a["netPay"] == 39920, f"T7a 临界 {t7a}")
t7b = calculate(emp("高管", 1080000, 0, 0, 0, 12), DEFAULT_CONFIG)
chk(t7b["detail"]["taxableIncomeCum"] == 1020000 and t7b["detail"]["bracketRate"] == 0.45 and t7b["taxCurrent"] == 277080, f"T7b 最高档 {t7b}")
t7c = calculate(emp("低薪", 4000, 0, 0, 0, 1), DEFAULT_CONFIG)
chk(t7c["detail"]["taxableIncomeCum"] == 0 and t7c["taxCurrent"] == 0 and t7c["netPay"] == 4000, f"T7c 0税 {t7c}")

if fails:
    print("FAIL:\n" + "\n".join(fails))
    sys.exit(1)
print("PASS: payroll.py 累计预扣 parity — T1-T7 与原 TS 引擎 golden 逐分一致")
