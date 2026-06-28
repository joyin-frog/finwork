#!/usr/bin/env python3
"""reconciliation.py 的 parity 自测:把原 TS golden(tests/reconciliation.test.ts 的
AC2.1/2.2/2.3/2.5 + 严格日期)逐字搬来,断言一致。AC2.4(工具 handler 错误处理)仍由 TS 测试覆盖。
由 tests/reconciliation-script.test.ts 进 CI。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reconciliation import reconcile  # noqa: E402

fails = []


def chk(cond, msg):
    if not cond:
        fails.append(msg)


def rec(bank, book, opts=None):
    return reconcile(bank, book, opts or {})


# ── AC2.1: 精确勾对 + 合计 ──
r1 = rec([{"date": "2026-06-01", "amount": 100, "direction": "in"}, {"date": "2026-06-02", "amount": 50, "direction": "out"}],
         [{"date": "2026-06-01", "amount": 100, "direction": "in"}, {"date": "2026-06-02", "amount": 50, "direction": "out"}])
chk(len(r1["matched"]) == 2 and not r1["bankOnly"] and not r1["bookOnly"], f"AC2.1 勾对: {r1['summary']}")
chk(r1["summary"]["balanced"] is True and r1["summary"]["matchedTotal"] == 150, f"AC2.1 合计/平: {r1['summary']}")
r_dir = rec([{"date": "2026-06-01", "amount": 100, "direction": "in"}], [{"date": "2026-06-01", "amount": 100, "direction": "out"}])
chk(len(r_dir["matched"]) == 0 and len(r_dir["bankOnly"]) == 1 and len(r_dir["bookOnly"]) == 1, "AC2.1 方向不同不匹配")

# ── AC2.2: 日期容差窗口 ──
bank = [{"date": "2026-06-01", "amount": 200, "direction": "in"}]
book = [{"date": "2026-06-03", "amount": 200, "direction": "in"}]
chk(len(rec(bank, book, {"dateWindowDays": 0})["matched"]) == 0, "AC2.2 窗口0 不跨日")
win = rec(bank, book, {"dateWindowDays": 3})
chk(len(win["matched"]) == 1 and win["matched"][0]["dateDiffDays"] == 2, f"AC2.2 窗口3 内匹配/差2天: {win['matched']}")

# ── AC2.3: 拆分/合并不静默 ──
split = rec([{"date": "2026-06-10", "amount": 3000, "direction": "out"}],
            [{"date": "2026-06-10", "amount": 1000, "direction": "out"}, {"date": "2026-06-10", "amount": 2000, "direction": "out"}])
chk(len(split["matched"]) == 0 and len(split["needsReview"]) == 1 and split["needsReview"][0]["side"] == "bank"
    and len(split["needsReview"][0]["many"]) == 2 and not split["bankOnly"] and not split["bookOnly"], f"AC2.3 拆分: {split}")
no_sum = rec([{"date": "2026-06-10", "amount": 3000, "direction": "out"}],
             [{"date": "2026-06-10", "amount": 1000, "direction": "out"}, {"date": "2026-06-10", "amount": 1500, "direction": "out"}])
chk(len(no_sum["needsReview"]) == 0 and len(no_sum["bankOnly"]) == 1 and len(no_sum["bookOnly"]) == 2, f"AC2.3 凑不上不误标: {no_sum['summary']}")

# ── AC2.5: 未匹配按金额倒序 + 下标可溯 ──
sort_res = rec([{"date": "2026-06-01", "amount": 50, "direction": "out"},
                {"date": "2026-06-02", "amount": 9000, "direction": "out"},
                {"date": "2026-06-03", "amount": 300, "direction": "out"}], [])
chk([r["amount"] for r in sort_res["bankOnly"]] == [9000, 300, 50], f"AC2.5 倒序: {[r['amount'] for r in sort_res['bankOnly']]}")
chk(sort_res["bankOnly"][0]["index"] == 1, "AC2.5 保留原始下标")

# ── 严格日期格式:非 YYYY-MM-DD 抛错 ──
try:
    rec([{"date": "2026/06/01", "amount": 100, "direction": "in"}], [{"date": "2026-06-01", "amount": 100, "direction": "in"}])
    chk(False, "strict-date 应抛错")
except ValueError as e:
    chk("应为 YYYY-MM-DD" in str(e), f"strict-date 错误信息: {e}")

if fails:
    print("FAIL:\n" + "\n".join(fails))
    sys.exit(1)
print("PASS: reconciliation.py parity — AC2.1/2.2/2.3/2.5 + 严格日期 与原 TS 一致")
