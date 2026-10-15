"""把测评结果整理成终端摘要和 evals/results/README.md 汇总表。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _p(v: Any) -> str:
    return "—" if v is None else f"{v * 100:.1f}%"


def _ms(v: Any) -> str:
    return "—" if v is None else f"{v / 1000:.2f}s" if v >= 1000 else f"{v}ms"


def _g(d: dict, *path: str) -> Any:
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)  # type: ignore[assignment]
    return d


def _name(r: dict) -> str:
    if r["mode"] == "offline":
        return "离线基线（关键词规则）"
    return r["models"].get("judge", "?")


def summarize(r: dict) -> str:
    t = r["tasks"]
    lines = [f"\n== 测评结果：{_name(r)}（{r['created']}，用时 {r['seconds']}s）"]
    if "judge" in t:
        j = t["judge"]
        lines.append(f"引用判断  n={j['n']}  准确率 {_p(j['accuracy'])}  支持 F1 {_p(j['support_f1'])}  "
                     f"假支持率 {_p(j['false_support_rate'])}  漏判支持 {_p(j['missed_support_rate'])}")
        if "zh" in j:
            lines.append(f"  中文论断 n={j['zh']['n']}  准确率 {_p(j['zh']['accuracy'])}  假支持率 {_p(j['zh']['false_support_rate'])}")
    if "fake_cite" in t:
        h = t["fake_cite"]["headline"]
        lines.append(f"假引用检出  随机 {_p(h['detect_random'])}  难例 {_p(h['detect_hard'])}（含黄色提示 {_p(h['detect_hard_any'])}）  "
                     f"正确引用误报 {_p(h['false_alarm_red'])}（含黄色 {_p(h['false_alarm_any'])}）")
    if "retrieval" in t:
        rt = t["retrieval"]
        parts = [f"{k} R@5 {_p(_g(rt, k, 'recall@5'))} MRR {_g(rt, k, 'mrr@10')}" for k in
                 ("en_bm25", "en_hybrid", "zh_bm25", "zh_bm25_expand", "zh_hybrid_expand") if k in rt]
        lines.append(f"检索（语料 {rt['corpus_size']} 段）  " + " | ".join(parts))
    if "missing" in t:
        m = t["missing"]
        lines.append(f"缺引用检测  {m['sentences']} 句  P {_p(m['precision'])}  R {_p(m['recall'])}  F1 {_p(m['f1'])}")
    if "latency" in t and "complete" in t["latency"]:
        c = t["latency"]["complete"]
        lines.append(f"行内续写  P50 {_ms(c['p50_ms'])}  P95 {_ms(c['p95_ms'])}  空结果 {_p(c['empty_rate'])}")
    cost = sum((u.get("cost_usd") or 0) for u in r.get("llm_usage", {}).values())
    calls = sum(u["calls"] for u in r.get("llm_usage", {}).values())
    if calls:
        lines.append(f"模型调用 {calls} 次，花费约 ${cost:.4f}")
    return "\n".join(lines)


HEADER = """# 测评结果

由 `npm run eval`（或 `cd backend && uv run python -m evals`）生成，每次运行追加一行。说明见 [../README.md](../README.md)。

| 运行 | 引用判断<br/>准确率 | 假支持率 ↓ | 中文论断<br/>准确率 | 假引用检出<br/>随机 / 难例 | 正确引用<br/>误报 ↓ | 检索 R@5<br/>英文 / 中文 / 中文+扩展 | 缺引用<br/>F1 | 续写<br/>P50 | 花费 |
|---|---|---|---|---|---|---|---|---|---|
"""


def write_index(results_dir: Path) -> None:
    rows = []
    for f in sorted(results_dir.glob("*.json")):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        t = r["tasks"]
        fk = _g(t, "fake_cite", "headline") or {}
        rt = t.get("retrieval") or {}
        cost = sum((u.get("cost_usd") or 0) for u in (r.get("llm_usage") or {}).values())
        limit = f"，每项 ≤{r['limit']} 条" if r.get("limit") else ""
        rows.append("| " + " | ".join([
            f"[{_name(r)}]({f.name})<br/><sub>{r['created'][:16].replace('T', ' ')}{limit}</sub>",
            _p(_g(t, "judge", "accuracy")),
            _p(_g(t, "judge", "false_support_rate")),
            _p(_g(t, "judge", "zh", "accuracy")),
            f"{_p(fk.get('detect_random'))} / {_p(fk.get('detect_hard'))}" if fk else "—",
            _p(fk.get("false_alarm_red")) if fk else "—",
            " / ".join(_p(_g(rt, k, "recall@5")) for k in ("en_bm25", "zh_bm25", "zh_bm25_expand")) if rt else "—",
            _p(_g(t, "missing", "f1")),
            _ms(_g(t, "latency", "complete", "p50_ms")),
            f"${cost:.3f}" if r["mode"] == "model" else "—",
        ]) + " |")
    (results_dir / "README.md").write_text(HEADER + "\n".join(rows) + "\n", encoding="utf-8")
