"""测评指标。全部是比例或毫秒数，保留 3 位小数。"""
from __future__ import annotations

import math


def rate(num: float, den: float) -> float | None:
    return round(num / den, 3) if den else None


def f1(p: float | None, r: float | None) -> float | None:
    if p is None or r is None or p + r == 0:
        return None if p is None or r is None else 0.0
    return round(2 * p * r / (p + r), 3)


def prf(tp: int, fp: int, fn: int) -> dict[str, float | None]:
    p, r = rate(tp, tp + fp), rate(tp, tp + fn)
    return {"precision": p, "recall": r, "f1": f1(p, r), "tp": tp, "fp": fp, "fn": fn}


def pct(values: list[float], p: float) -> int | None:
    """最近秩法百分位数"""
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, math.ceil(p / 100 * len(s)) - 1))
    return int(round(s[k]))


def ranking_metrics(ranked: list[tuple[list[str], set[str]]]) -> dict[str, float | None]:
    """ranked: [(检索结果 id 列表, 正确答案 id 集合)]。Recall@k 指前 k 条里至少命中一个正确答案。"""
    n = len(ranked)
    out: dict[str, float | None] = {}
    for k in (1, 5, 10):
        out[f"recall@{k}"] = rate(sum(bool(set(r[:k]) & g) for r, g in ranked), n)
    rr = 0.0
    for r, g in ranked:
        for i, pid in enumerate(r[:10], start=1):
            if pid in g:
                rr += 1 / i
                break
    out["mrr@10"] = round(rr / n, 3) if n else None
    return out
