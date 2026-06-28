#!/usr/bin/env python3
"""报销校验引擎(reimbursement-check skill 固定脚本,确定性)。

validate:缺字段 / 金额异常 / 单笔超标 / 批内发票号重复 / 跨月历史重复(按固定顺序追加警告);
sort:异常按风险排序(历史重复 > 批内重复 > 超标 > 金额/缺字段 > 无异常)。
parity 见 selftest_reimbursement.py。单笔上限(singleLimit)由调用方传入(运行期可配)。

用法:`echo '{"op":"validate","items":[...],"policy":{"singleLimit":1500},"history":{...}}' | python3 reimbursement.py`
"""
import sys
import json

# 警告追加顺序(与原 TS 一致):缺日期→缺类目→金额异常→超标→批内重复→历史重复
# 风险排序优先级(越靠前越高危)
WARNING_RISK_ORDER = ["历史重复", "发票号重复", "超过单笔标准", "金额异常", "缺少日期", "缺少类目"]


def validate(items, policy, history):
    single_limit = policy.get("singleLimit", 0)
    counts = {}
    for it in items:
        k = it.get("invoiceNo")
        counts[k] = counts.get(k, 0) + 1
    out = []
    for it in items:
        w = []
        if not it.get("expenseDate"):
            w.append("缺少日期")
        if not it.get("category"):
            w.append("缺少类目")
        amount = it.get("amount") or 0
        if amount <= 0:
            w.append("金额异常")
        if amount > single_limit:
            w.append("超过单笔标准")
        if counts.get(it.get("invoiceNo"), 0) > 1:
            w.append("发票号重复")
        prior = (history or {}).get(it.get("invoiceNo"))
        if prior:
            w.append(f"历史重复({(prior.get('recordedAt') or '')[:7]} 已登记)")
        out.append({**it, "warnings": w})
    return out


def _risk_rank(item):
    w = item.get("warnings") or []
    if not w:
        return len(WARNING_RISK_ORDER)
    ranks = []
    for warn in w:
        idx = next((i for i, p in enumerate(WARNING_RISK_ORDER) if warn.startswith(p)), -1)
        ranks.append(len(WARNING_RISK_ORDER) - 1 if idx == -1 else idx)
    return min(ranks)


def sort_by_risk(items):
    # 稳定排序(同 JS Array.sort 稳定语义):同风险保持原序
    return sorted(items, key=_risk_rank)


def run(payload):
    op = payload.get("op")
    if op == "validate":
        return {"results": validate(payload.get("items", []), payload.get("policy") or {}, payload.get("history") or {})}
    if op == "sort":
        return {"results": sort_by_risk(payload.get("items", []))}
    return {"error": f"未知 op: {op}"}


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"输入解析失败: {e}"}, ensure_ascii=False))
        sys.exit(2)
    print(json.dumps(run(payload), ensure_ascii=False))


if __name__ == "__main__":
    main()
