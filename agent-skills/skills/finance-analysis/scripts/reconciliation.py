#!/usr/bin/env python3
"""银行流水对账引擎(确定性,零网络、零付款动作)。

按"方向 + 金额到分 + 日期容差窗口"勾对:阶段一一对一精确勾对,阶段二疑似拆分/合并(1↔多
求和相等)只标注交人工、绝不自动合并。未达项按金额倒序(风险排序)。parity 见 selftest_reconciliation.py。

用法:`echo '{"bank":[...],"book":[...],"options":{"dateWindowDays":0}}' | python3 reconciliation.py`
"""
import sys
import json
import math
import re
import datetime

_DAY_MS = 86_400_000


def _round2(v):
    return math.floor(v * 100 + 0.5) / 100  # JS Math.round 半数进位


def _normalize(row, index, label):
    d = row.get("direction")
    if d not in ("in", "out"):
        raise ValueError(f"{label}第 {index + 1} 行:方向必须是 in 或 out,实际为 {d}")
    amt = row.get("amount")
    if not isinstance(amt, (int, float)) or isinstance(amt, bool) or not math.isfinite(amt) or amt <= 0:
        raise ValueError(f"{label}第 {index + 1} 行:金额必须是正数,实际为 {amt}")
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(row.get("date", "")).strip())
    if not m:
        raise ValueError(f"{label}第 {index + 1} 行:日期无法解析(应为 YYYY-MM-DD),实际为 {row.get('date')}")
    time_ms = int(datetime.datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=datetime.timezone.utc).timestamp() * 1000)
    return {**row, "index": index, "cents": math.floor(amt * 100 + 0.5), "time": time_ms, "direction": d, "amount": amt}


def reconcile(bank_input, book_input, options):
    window = options.get("dateWindowDays", 0) or 0
    if not isinstance(window, int) or isinstance(window, bool) or window < 0:
        raise ValueError(f"日期容差窗口必须是 >=0 的整数,实际为 {options.get('dateWindowDays')}")
    bank = [_normalize(r, i, "银行流水") for i, r in enumerate(bank_input)]
    book = [_normalize(r, i, "账面") for i, r in enumerate(book_input)]

    # 阶段一:一对一精确勾对(方向 + 金额到分 + 日期窗口内,取最近、同近取下标小)
    matched = []
    used_book = set()
    for b in bank:
        best, best_diff = None, float("inf")
        for k in book:
            if k["index"] in used_book or k["direction"] != b["direction"] or k["cents"] != b["cents"]:
                continue
            diff = abs(b["time"] - k["time"]) / _DAY_MS
            if diff > window:
                continue
            if diff < best_diff or (diff == best_diff and best is not None and k["index"] < best["index"]):
                best, best_diff = k, diff
        if best is not None:
            matched.append({"bank": b, "book": best, "dateDiffDays": math.floor(best_diff + 0.5)})
            used_book.add(best["index"])

    bank_unmatched = [b for b in bank if not any(m["bank"]["index"] == b["index"] for m in matched)]
    book_unmatched = [k for k in book if k["index"] not in used_book]

    # 阶段二:疑似拆分/合并(1↔多 求和相等),只标注交人工、被纳入的行移出未达清单
    needs_review = []
    consumed_bank, consumed_book = set(), set()

    def detect(singles, multi_pool, side, consumed_single, consumed_multi):
        for one in singles:
            if one["index"] in consumed_single:
                continue
            candidates = [m for m in multi_pool
                          if m["index"] not in consumed_multi and m["direction"] == one["direction"]
                          and abs(m["time"] - one["time"]) / _DAY_MS <= window]
            if len(candidates) < 2 or sum(c["cents"] for c in candidates) != one["cents"]:
                continue
            amt = f"{one['cents'] / 100:.2f}"
            note = (f"1 条银行流水(¥{amt})疑似对应 {len(candidates)} 条账面记录之和,请人工核对是否拆分入账"
                    if side == "bank" else
                    f"1 条账面记录(¥{amt})疑似对应 {len(candidates)} 条银行流水之和,请人工核对是否合并收付")
            needs_review.append({"side": side, "one": one, "many": candidates, "note": note})
            consumed_single.add(one["index"])
            for c in candidates:
                consumed_multi.add(c["index"])

    detect(bank_unmatched, book_unmatched, "bank", consumed_bank, consumed_book)
    detect(book_unmatched, bank_unmatched, "book", consumed_book, consumed_bank)
    bank_unmatched = [b for b in bank_unmatched if b["index"] not in consumed_bank]
    book_unmatched = [k for k in book_unmatched if k["index"] not in consumed_book]

    bank_only = sorted(bank_unmatched, key=lambda r: (-r["cents"], r["index"]))
    book_only = sorted(book_unmatched, key=lambda r: (-r["cents"], r["index"]))
    return {
        "matched": matched,
        "bankOnly": bank_only,
        "bookOnly": book_only,
        "needsReview": needs_review,
        "summary": {
            "bankCount": len(bank),
            "bookCount": len(book),
            "matchedCount": len(matched),
            "bankOnlyTotal": _round2(sum(r["cents"] for r in bank_only) / 100),
            "bookOnlyTotal": _round2(sum(r["cents"] for r in book_only) / 100),
            "matchedTotal": _round2(sum(m["bank"]["cents"] for m in matched) / 100),
            "balanced": not bank_only and not book_only and not needs_review,
        },
    }


def run(payload):
    try:
        return {"result": reconcile(payload.get("bank", []), payload.get("book", []), payload.get("options") or {})}
    except ValueError as e:
        return {"error": str(e)}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"输入解析失败: {e}"}, ensure_ascii=False))
        sys.exit(2)
    print(json.dumps(run(payload), ensure_ascii=False))


if __name__ == "__main__":
    main()
