"""测评任务。每个任务调用的都是系统里真实在用的函数（assist / retrieval），不另写一套逻辑。

  judge       引用支撑判断：给定论断和文献片段，判断 supports / partial / unrelated
  fake_cite   假引用检出：把正确引用换成随机或“看起来相关”的另一篇文献，看页边批注能否标出
  retrieval   检索：给论断找到能支撑它的文献（英文 / 中文 / 中文 + 跨语言关键词扩展）
  missing     缺引用检测：中文段落里哪些句子需要引用
  latency     行内续写延迟 + 本次测评所有模型调用的延迟与花费汇总
"""
from __future__ import annotations

import random
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .datasets import Bundle, Pair, sample
from .metrics import f1, pct, prf, rate, ranking_metrics

VERDICTS = ("supports", "partial", "unrelated", "unknown")


def _pmap(fn: Callable, items: list, workers: int, label: str) -> list:
    """并发执行并在终端显示进度。模型调用是 IO 密集，线程池足够。"""
    out: list = [None] * len(items)
    done = 0
    step = max(1, len(items) // 10)

    def run(i: int) -> None:
        out[i] = fn(items[i])

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for _ in ex.map(run, range(len(items))):
            done += 1
            if done % step == 0 or done == len(items):
                print(f"  {label}: {done}/{len(items)}", file=sys.stderr, flush=True)
    return out


@dataclass
class _PaperStub:
    """judge_support 只用到标题和年份；测评数据没有标题，用中性的占位"""
    title: str = "（测评文献）"
    year: int | None = None


# ---------------------------------------------------------------------------
# 文献库：把所有证据段落作为“论文”存入测评专用的数据库
# ---------------------------------------------------------------------------
class Library:
    def __init__(self, bundle: Bundle):
        import app.ingest as ingest
        from app.db import get_conn
        from app.embeddings import embed_texts, embeddings_enabled, to_blob
        from app.library import PaperIn, add_paper
        from app.retrieval import invalidate_index

        self.passages = bundle.passages
        self.pid: dict[str, str] = {}
        self.text: dict[str, str] = {}
        t0 = time.perf_counter()
        use_emb = embeddings_enabled()
        orig = ingest.embeddings_enabled
        ingest.embeddings_enabled = lambda: False  # 先只写文本，向量最后批量算
        try:
            for i, text in enumerate(self.passages):
                paper, _ = add_paper(PaperIn(title=f"Evidence E{i:04d}", abstract=text, source="eval"))
                ingest.store_chunks(paper.id, [ingest.Chunk(text, "Abstract", None)], fulltext=False)
                self.pid[text] = paper.id
                self.text[paper.id] = text
        finally:
            ingest.embeddings_enabled = orig
        if use_emb:
            print(f"  计算 {len(self.passages)} 段向量…", file=sys.stderr, flush=True)
            with get_conn() as conn:
                rows = [(r["id"], r["text"]) for r in conn.execute("SELECT id, text FROM chunks")]
            vecs = embed_texts([t for _, t in rows], batch=64)
            with get_conn() as conn:
                conn.executemany("UPDATE chunks SET embedding=? WHERE id=?", [(to_blob(v), cid) for (cid, _), v in zip(rows, vecs)])
            invalidate_index()
        self.build_seconds = round(time.perf_counter() - t0, 1)


# ---------------------------------------------------------------------------
# 1. 引用支撑判断
# ---------------------------------------------------------------------------
def _judge_metrics(golds: list[bool], preds: list[str]) -> dict[str, Any]:
    pos = [p for g, p in zip(golds, preds) if g]
    neg = [p for g, p in zip(golds, preds) if not g]
    tp = sum(p == "supports" for p in pos)
    fp = sum(p == "supports" for p in neg)
    fn = len(pos) - tp
    tn = len(neg) - fp
    return {
        "n": len(golds), "n_supported": len(pos), "n_not_supported": len(neg),
        # 严格口径：只有 supports 算“支持”
        "accuracy": rate(tp + tn, len(golds)),
        "support_precision": rate(tp, tp + fp),
        "support_recall": rate(tp, tp + fn),
        "support_f1": f1(rate(tp, tp + fp), rate(tp, tp + fn)),
        # 最要紧的错误：证据撑不起论断，却判成“支持”（放过假引用）
        "false_support_rate": rate(fp, len(neg)),
        # 宽松口径：partial 也算没否定，看真正支持的论断有多少被判成 unrelated
        "missed_support_rate": rate(sum(p == "unrelated" for p in pos), len(pos)),
        "unknown_rate": rate(sum(p == "unknown" for p in preds), len(preds)),
        "confusion": {
            "supported": dict(Counter(pos)),
            "not_supported": dict(Counter(neg)),
        },
    }


def run_judge(bundle: Bundle, limit: int | None, workers: int) -> dict[str, Any]:
    from app.assist import judge_support

    pairs = sample(bundle.pairs, limit)
    preds = _pmap(lambda p: judge_support(p.claim, _PaperStub(), p.evidence)["verdict"], pairs, workers, "judge")
    res = _judge_metrics([p.supported for p in pairs], preds)

    # 中文论断 + 英文文献（真实使用场景：用户写中文、文献库是英文论文）
    # 译文只覆盖被支持的论断，所以为每条正例再配一段随机的其他证据作为负例，正负各半
    rng = random.Random(11)
    related: dict[str, set[str]] = {}
    for p in bundle.pairs:
        related.setdefault(p.claim, set()).add(p.evidence)
    pool = list(dict.fromkeys(p.evidence for p in bundle.pairs))
    zh_pairs: list[Pair] = []
    for p in sample([p for p in bundle.pairs if p.supported and p.claim in bundle.zh_claims], limit):
        zh = bundle.zh_claims[p.claim]
        zh_pairs.append(Pair(zh, p.evidence, True))
        others = [e for e in pool if e not in related[p.claim]]
        if others:
            zh_pairs.append(Pair(zh, rng.choice(others), False))
    if zh_pairs:
        zh_preds = _pmap(lambda p: judge_support(p.claim, _PaperStub(), p.evidence)["verdict"], zh_pairs, workers, "judge_zh")
        res["zh"] = _judge_metrics([p.supported for p in zh_pairs], zh_preds)
    return res


# ---------------------------------------------------------------------------
# 2. 假引用检出（走页边批注同一条路径：verify_citation = 在被引文献里检索片段 + 判断）
# ---------------------------------------------------------------------------
def run_fake_cite(bundle: Bundle, lib: Library, limit: int | None, workers: int) -> dict[str, Any]:
    from app.assist import verify_citation
    from app.retrieval import search

    rng = random.Random(7)
    related: dict[str, set[str]] = {}
    for p in bundle.pairs:  # 同一论断的所有证据（不论标签）都不能拿来当“假引用”
        related.setdefault(p.claim, set()).add(p.evidence)
    pos = sample([p for p in bundle.pairs if p.supported], limit)
    pool = [e for e in dict.fromkeys(p.evidence for p in bundle.pairs)]

    cases: list[tuple[str, str, str]] = []  # (kind, claim, paper_id)
    for p in pos:
        cases.append(("true", p.claim, lib.pid[p.evidence]))
        cands = [e for e in pool if e not in related[p.claim]]
        cases.append(("random_fake", p.claim, lib.pid[rng.choice(cands)]))
        # 难例：检索排名最靠前、但并不支撑这句话的另一篇文献（主题相近，最容易蒙混过关）
        hard = next((h.text for h in search(p.claim, top_k=30) if h.text not in related[p.claim]), None)
        if hard:
            cases.append(("hard_fake", p.claim, lib.pid[hard]))

    verdicts = _pmap(lambda c: verify_citation(c[1], c[2])["verdict"], cases, workers, "fake_cite")
    by: dict[str, list[str]] = {}
    for (kind, _, _), v in zip(cases, verdicts):
        by.setdefault(kind, []).append(v)

    def summary(vs: list[str]) -> dict[str, Any]:
        return {
            "n": len(vs),
            "flagged_red": rate(sum(v == "unrelated" for v in vs), len(vs)),      # 页边卡片标红：不相关
            "flagged_any": rate(sum(v != "supports" for v in vs), len(vs)),        # 标红或标黄（部分支持）都会出卡片
            "verdicts": dict(Counter(vs)),
        }

    res = {k: summary(v) for k, v in by.items()}
    t, r, h = res.get("true", {}), res.get("random_fake", {}), res.get("hard_fake", {})
    res["headline"] = {
        "detect_random": r.get("flagged_red"),
        "detect_hard": h.get("flagged_red"),
        "detect_hard_any": h.get("flagged_any"),
        "false_alarm_red": t.get("flagged_red"),
        "false_alarm_any": t.get("flagged_any"),
    }
    return res


# ---------------------------------------------------------------------------
# 3. 检索
# ---------------------------------------------------------------------------
def run_retrieval(bundle: Bundle, lib: Library, limit: int | None, fake: bool) -> dict[str, Any]:
    import app.retrieval as R
    from app.assist import retrieval_query
    from app.embeddings import embeddings_enabled

    gold: dict[str, set[str]] = {}
    for p in bundle.pairs:
        if p.supported:
            gold.setdefault(p.claim, set()).add(lib.pid[p.evidence])
    claims = sample(sorted(gold), limit)
    zh = [c for c in claims if c in bundle.zh_claims]

    def evaluate(queries: list[tuple[str, str]], hybrid: bool) -> dict[str, Any]:
        orig = R.embeddings_enabled
        if not hybrid:
            R.embeddings_enabled = lambda: False  # 只用 BM25
        try:
            ranked = []
            for claim, q in queries:
                ranked.append(([h.paper_id for h in R.search(q, top_k=10)], gold[claim]))
        finally:
            R.embeddings_enabled = orig
        return ranking_metrics(ranked) | {"n": len(queries)}

    res: dict[str, Any] = {"corpus_size": len(lib.passages), "embeddings": embeddings_enabled()}
    res["en_bm25"] = evaluate([(c, c) for c in claims], hybrid=False)
    res["zh_bm25"] = evaluate([(c, bundle.zh_claims[c]) for c in zh], hybrid=False)
    if not fake:  # 关键词扩展要调用模型
        expanded = _pmap(lambda c: (c, retrieval_query(bundle.zh_claims[c])), zh, 4, "zh_expand")
        res["zh_bm25_expand"] = evaluate(expanded, hybrid=False)
        # 扩展失败（模型返回空）时查询不变，这个比例高说明关键词扩展没生效
        res["zh_bm25_expand"]["expand_failed_rate"] = rate(sum(q == bundle.zh_claims[c] for c, q in expanded), len(expanded))
        if embeddings_enabled():
            res["en_hybrid"] = evaluate([(c, c) for c in claims], hybrid=True)
            res["zh_hybrid_expand"] = evaluate(expanded, hybrid=True)
    return res


# ---------------------------------------------------------------------------
# 4. 缺引用检测（页边批注的“这句话缺少引用”）
# ---------------------------------------------------------------------------
_PUNCT = re.compile(r"[\s，。；！？、：,.;!?:\"'“”‘’（）()]")


def _norm(s: str) -> str:
    return _PUNCT.sub("", s)


def run_missing(bundle: Bundle, limit: int | None, workers: int) -> dict[str, Any]:
    from app.assist import _review, strip_cites

    paras = sample(bundle.citeworthy, limit)

    def one(para: dict) -> list[int]:
        sents = [s["text"] for s in para["sentences"]]
        plain = "".join(sents)
        try:
            data = _review(plain, plain, para.get("title", ""))
        except Exception:  # noqa: BLE001
            return []
        picked: list[int] = []
        # 与 annotate() 完全相同的过滤：最多 2 句，必须原样出自段落
        for m in (data.get("missing") or [])[:2]:
            sent = strip_cites(str(m.get("sentence", ""))).replace("[引用]", "").strip()
            if len(sent) < 6 or sent not in plain:
                continue
            ns = _norm(sent)
            for i, s in enumerate(sents):
                if ns and (ns in _norm(s) or _norm(s) in ns):
                    picked.append(i)
                    break
        return sorted(set(picked))

    preds = _pmap(one, paras, workers, "missing")
    tp = fp = fn = 0
    for para, picked in zip(paras, preds):
        golds = {i for i, s in enumerate(para["sentences"]) if s["cite"]}
        tp += len(golds & set(picked))
        fp += len(set(picked) - golds)
        fn += len(golds - set(picked))
    n_sent = sum(len(p["sentences"]) for p in paras)
    return {"paragraphs": len(paras), "sentences": n_sent, "gold_positive": tp + fn, "flagged": tp + fp} | prf(tp, fp, fn)


# ---------------------------------------------------------------------------
# 5. 延迟与花费
# ---------------------------------------------------------------------------
def run_latency(bundle: Bundle, limit: int | None) -> dict[str, Any]:
    from app.assist import complete

    paras = sample(bundle.citeworthy, limit or 20)
    times = []
    empty = 0
    for p in paras:
        before = "".join(s["text"] for s in p["sentences"][:2])
        t0 = time.perf_counter()
        try:
            text = complete(before, title=p.get("title", ""), use_library=False)
            empty += not text.strip()
        except Exception:  # noqa: BLE001
            empty += 1
        times.append((time.perf_counter() - t0) * 1000)
    return {"complete": {"n": len(times), "p50_ms": pct(times, 50), "p95_ms": pct(times, 95),
                         "empty_rate": rate(empty, len(times))}}


def llm_usage() -> dict[str, Any]:
    """汇总本次测评期间所有模型调用（测评用的是独立数据库，不会混入平时的使用记录）"""
    from app import pricing
    from app.db import get_conn

    out: dict[str, Any] = {}
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT ts, tier, model, ok, latency_ms, prompt_tokens, completion_tokens, cached_tokens, cost_usd FROM llm_calls")]
    for r in rows:
        r["cost_cny"] = pricing.call_cost(r, pricing.price_for(r["model"])) if r["ok"] else None
    for tier in sorted({r["tier"] for r in rows}):
        rs = [r for r in rows if r["tier"] == tier]
        lat = [r["latency_ms"] for r in rs if r["ok"] and r["latency_ms"] is not None]
        cost = [r["cost_usd"] for r in rs if r["cost_usd"] is not None]
        out[tier] = {
            "models": sorted({r["model"] for r in rs}),
            "calls": len(rs),
            "error_rate": rate(sum(not r["ok"] for r in rs), len(rs)),
            "p50_ms": pct(lat, 50), "p95_ms": pct(lat, 95),
            "prompt_tokens": sum(r["prompt_tokens"] or 0 for r in rs),
            "completion_tokens": sum(r["completion_tokens"] or 0 for r in rs),
            "cost_usd": round(sum(cost), 4) if cost else None,
            "cost_cny": round(sum(c for c in cny), 4) if (cny := [r["cost_cny"] for r in rs if r["cost_cny"] is not None]) else None,
        }
    return out


def iter_tasks(names: Iterable[str]) -> list[str]:
    allowed = ["judge", "fake_cite", "retrieval", "missing", "locate", "latency"]
    names = list(names)
    bad = [n for n in names if n not in allowed]
    if bad:
        raise SystemExit(f"未知任务：{', '.join(bad)}；可选：{', '.join(allowed)}")
    return [n for n in allowed if n in names]
