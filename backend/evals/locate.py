"""原文定位测评：「看原文」高亮的是不是依据句，「最相关的原文」能不能找到依据所在的段落。

做法
  1. 用 SciFact 的论断—证据对（只取「支持」的那部分）造出双栏排版的论文 PDF：
     每个依据段落 = 证据原文 + 3 句与论断词汇重合较高的干扰句（来自别的论文），证据随机放在段落中间某处；
     每份 PDF 8 个这样的段落，再混入 8 个纯干扰段落，按章节排成两栏、跨多页。
  2. 和真实流程一样：把 PDF 解析、切块，取包含证据的那一块作为「依据片段」，
     调用 pdfview.locate(片段, 论断) 得到高亮矩形；调用 pdfview.passages(论断) 得到最相关的 3 段。
  3. 用 PDF 里每个词的真实坐标（与定位算法无关的另一套方法）判断高亮落在哪些词上。

指标
  定位准确率      高亮的文字里至少 60% 属于证据原文（只高亮了干扰句、或没找到都算错）
  高亮精确率      高亮文字中属于证据的比例（平均）；基线「整块高亮」= 把整个依据片段都标出来
  证据覆盖率      证据原文被高亮的比例（平均）
  段落 R@1 / R@3  「最相关的原文」前 k 段里包含证据
  中文论断        同样的数据换成中文论断（跨语言：中文论断找英文原文）
"""
from __future__ import annotations

import random
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .datasets import Bundle
from .metrics import pct, rate

PER_DOC = 8  # 每份 PDF 的依据段落数
FILLER = 8  # 每份 PDF 的纯干扰段落数
_WORD = re.compile(r"[a-z0-9]+")
_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")


# 通用干扰句：数据里干扰语料不够时（如 --source fixture）补位
_GENERIC = [
    "The experimental setup follows standard practice and all hyper-parameters are kept fixed across datasets.",
    "We report averages over three random seeds together with the standard deviation in the appendix.",
    "Participants were recruited from three hospitals between 2015 and 2018 and followed for two years.",
    "Further details on data collection and preprocessing are provided in the supplementary material.",
    "Statistical significance was assessed with a two-sided t-test at the 0.05 level.",
    "The remaining samples were excluded because of missing baseline measurements.",
    "All analyses were performed with publicly available software packages.",
    "Limitations of this study include the relatively small sample size and the observational design.",
    "These results were consistent across subgroups defined by age, sex and baseline severity.",
    "Code and data will be released upon publication to support reproducibility.",
    "Previous work has examined related questions in smaller cohorts with mixed results.",
    "The authors declare no competing interests related to this work.",
]


def _pool(bundle: Bundle) -> list[str]:
    pool = [s for d in bundle.distractors for s in _sents(d) if 40 <= len(s) <= 300]
    return pool + _GENERIC if len(pool) < 50 else pool


def _toks(s: str) -> list[str]:
    return _WORD.findall(s.lower())


def _sents(s: str) -> list[str]:
    return [x.strip() for x in _SENT.split(re.sub(r"\s+", " ", s)) if len(x.strip()) > 20]


@dataclass
class Item:
    claim: str
    zh: str | None
    evidence: str
    paragraph: str
    doc: int


# ---------------------------------------------------------------------------
# 造数据
# ---------------------------------------------------------------------------
def build_items(bundle: Bundle, limit: int | None, seed: int = 7) -> list[Item]:
    rng = random.Random(seed)
    seen: set[str] = set()
    pairs = []
    for p in bundle.pairs:
        if p.supported and p.claim not in seen and 60 <= len(p.evidence) <= 700:
            seen.add(p.claim)
            pairs.append(p)
    rng.shuffle(pairs)
    if limit:
        pairs = pairs[:limit]
    pool = _pool(bundle)
    pool_toks = [set(_toks(s)) for s in pool]
    evidences = {p.evidence for p in bundle.pairs}
    items = []
    for i, p in enumerate(pairs):
        ct = set(_toks(p.claim))
        et = set(_toks(p.evidence))
        # 与论断重合较高、但和证据本身不太像的句子当干扰（太像的可能其实也支持论断）
        scored = sorted(range(len(pool)), key=lambda j: -len(ct & pool_toks[j]))[:40]
        cands = [pool[j] for j in scored if len(et & pool_toks[j]) / max(1, len(pool_toks[j])) < 0.5 and pool[j] not in evidences]
        dis = rng.sample(cands[:20], k=min(3, len(cands[:20])))
        sents = list(dis)
        sents.insert(rng.randint(0, len(sents)), p.evidence)
        items.append(Item(p.claim, bundle.zh_claims.get(p.claim), p.evidence, " ".join(sents), i // PER_DOC))
    return items


def _filler(rng: random.Random, pool: list[str], n: int) -> list[str]:
    return [" ".join(rng.sample(pool, min(4, len(pool)))) for _ in range(n)]


def render_pdf(path: Path, title: str, paragraphs: list[str]) -> None:
    """双栏论文排版：标题通栏，正文两栏两端对齐，按段落自动换栏、换页。"""
    import fitz

    doc = fitz.open()
    W, H, M, G, BOTTOM = 595.0, 842.0, 54.0, 18.0, 60.0
    colw = (W - 2 * M - G) / 2
    state = {"page": None, "col": 0, "y": 0.0, "top": 0.0}
    def height(text: str, size: float, font: str) -> float:
        probe = fitz.open()
        rest = probe.new_page(width=W, height=4000).insert_textbox(fitz.Rect(0, 0, colw, 4000), text, fontsize=size, fontname=font, align=3)
        probe.close()
        return 4000 - rest

    def new_page(first: bool = False) -> None:
        state["page"] = doc.new_page(width=W, height=H)
        state["col"], state["top"] = 0, (150.0 if first else 60.0)
        state["y"] = state["top"]
        if first:
            state["page"].insert_textbox(fitz.Rect(M, 64, W - M, 120), title, fontsize=15, fontname="tibo", align=1)

    def write(text: str, size: float = 9.6, font: str = "tiro", gap: float = 7.0) -> None:
        words = text.split()
        while words:
            x = M + state["col"] * (colw + G)
            room = H - BOTTOM - state["y"]
            # 二分找出这一栏剩余空间放得下多少词
            lo, hi, fit = 1, len(words), 0
            while lo <= hi:
                mid = (lo + hi) // 2
                if room > 14 and height(" ".join(words[:mid]), size, font) <= room:
                    fit, lo = mid, mid + 1
                else:
                    hi = mid - 1
            if fit:
                chunk = " ".join(words[:fit])
                h = height(chunk, size, font)
                state["page"].insert_textbox(fitz.Rect(x, state["y"], x + colw, state["y"] + h + 2), chunk, fontsize=size, fontname=font, align=3)
                state["y"] += h + gap
                words = words[fit:]
            if words:
                if state["col"] == 0:
                    state["col"], state["y"] = 1, state["top"]
                else:
                    new_page()

    new_page(first=True)
    for i, para in enumerate(paragraphs):
        if i % 4 == 0:
            write(f"{i // 4 + 1} Section {i // 4 + 1}", size=11, font="tibo", gap=4)
        write(para)
    for n, pg in enumerate(doc, 1):
        pg.insert_text((W / 2 - 3, H - 30), str(n), fontsize=9, fontname="tiro")
    doc.save(str(path))


# ---------------------------------------------------------------------------
# 用词的坐标判断高亮落点（与定位算法无关）
# ---------------------------------------------------------------------------
def _page_words(path: Path) -> tuple[list[list[tuple]], list[tuple[float, float]]]:
    """每页的词（含坐标）和页面尺寸"""
    import fitz

    with fitz.open(str(path)) as d:
        return [[tuple(w[:5]) for w in pg.get_text("words")] for pg in d], [(pg.rect.width, pg.rect.height) for pg in d]


def _gold_words(pages_words, evidence: str) -> tuple[int, set[int]] | None:
    """在 PDF 的词序列里找到证据原文，返回 (页码, 该页上属于证据的词下标)"""
    target = _toks(evidence)
    flat = []  # (page, idx, token)
    for p, words in enumerate(pages_words, 1):
        for i, w in enumerate(words):
            for t in _toks(w[4]):
                flat.append((p, i, t))
    toks = [f[2] for f in flat]
    n = len(target)
    for s in range(len(toks) - n + 1):
        if toks[s] == target[0] and toks[s : s + n] == target:
            span = flat[s : s + n]
            page = max({x[0] for x in span}, key=lambda q: sum(1 for x in span if x[0] == q))
            return page, {x[1] for x in span if x[0] == page}
    return None


def _highlighted(words, size, rects: list[list[float]]) -> set[int]:
    w, h = size
    boxes = [(r[0] * w - 1.5, r[1] * h - 1.5, r[2] * w + 1.5, r[3] * h + 1.5) for r in rects]
    out = set()
    for i, (x0, y0, x1, y1, _) in enumerate(words):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes):
            out.add(i)
    return out


# ---------------------------------------------------------------------------
# 测评
# ---------------------------------------------------------------------------
def _score(res: dict, pages_words, sizes, gold: tuple[int, set[int]]) -> dict[str, float]:
    gpage, gwords = gold
    if not res.get("found") or res.get("page") != gpage:
        return {"hit": 0.0, "precision": 0.0, "coverage": 0.0}
    hl = _highlighted(pages_words[gpage - 1], sizes[gpage - 1], res["rects"])
    prec = len(hl & gwords) / len(hl) if hl else 0.0
    cov = len(hl & gwords) / len(gwords) if gwords else 0.0
    return {"hit": float(prec >= 0.6), "precision": prec, "coverage": cov}


def _mean(xs: list[float]) -> float | None:
    return round(sum(xs) / len(xs), 3) if xs else None


def _contains(passage: str, evidence: str) -> bool:
    et = _toks(evidence)
    pt = set(_toks(passage))
    return bool(et) and sum(t in pt for t in et) / len(et) >= 0.8


def run_locate(bundle: Bundle, limit: int | None) -> dict[str, Any]:
    from app import pdfview
    from app.ingest import chunk_paragraphs, extract_pdf_pages, split_paragraphs

    items = build_items(bundle, limit)
    rng = random.Random(11)
    pool = _pool(bundle)
    tmp = Path(tempfile.mkdtemp(prefix="aria-locate-"))
    docs: dict[int, Path] = {}
    for d in sorted({it.doc for it in items}):
        paras = [it.paragraph for it in items if it.doc == d] + _filler(rng, pool, FILLER)
        rng.shuffle(paras)
        docs[d] = tmp / f"doc{d}.pdf"
        render_pdf(docs[d], f"Synthetic Evaluation Paper {d + 1}", paras)

    variants: dict[str, dict[str, list]] = {k: {"hit": [], "precision": [], "coverage": []} for k in ("claim", "first_sentence", "whole_chunk")}
    zh_loc: dict[str, list] = {"hit": [], "precision": [], "coverage": []}
    ranks_en: list[int | None] = []
    ranks_zh: list[int | None] = []
    lat: list[float] = []
    skipped = 0
    cache: dict[int, tuple] = {}
    for it in items:
        path = docs[it.doc]
        if it.doc not in cache:
            pw, sizes = _page_words(path)
            chunks = chunk_paragraphs(split_paragraphs(extract_pdf_pages(path)))
            cache[it.doc] = (pw, sizes, chunks)
        pw, sizes, chunks = cache[it.doc]
        gold = _gold_words(pw, it.evidence)
        chunk = max(chunks, key=lambda c: sum(t in set(_toks(c.text)) for t in _toks(it.evidence)))
        if not gold or not _contains(chunk.text, it.evidence):
            skipped += 1  # 证据被切到两块里或排版异常，跳过（单独计数）
            continue
        t0 = time.perf_counter()
        res = pdfview.locate(path, chunk.text, chunk.page, it.claim)
        lat.append((time.perf_counter() - t0) * 1000)
        for k, v in _score(res, pw, sizes, gold).items():
            variants["claim"][k].append(v)
        for k, v in _score(pdfview.locate(path, chunk.text, chunk.page, ""), pw, sizes, gold).items():
            variants["first_sentence"][k].append(v)
        # 整块高亮：把整个依据片段都标出来（覆盖率 100%，精确率 = 证据在片段里的占比）
        prec = len(_toks(it.evidence)) / max(1, len(_toks(chunk.text)))
        variants["whole_chunk"]["precision"].append(min(1.0, prec))
        variants["whole_chunk"]["coverage"].append(1.0)
        variants["whole_chunk"]["hit"].append(float(prec >= 0.6))

        ps = pdfview.passages(path, it.claim, 3)
        ranks_en.append(next((i for i, p in enumerate(ps, 1) if _contains(p["text"], it.evidence)), None))
        if it.zh:
            for k, v in _score(pdfview.locate(path, chunk.text, chunk.page, it.zh), pw, sizes, gold).items():
                zh_loc[k].append(v)
            ps = pdfview.passages(path, it.zh, 3)
            ranks_zh.append(next((i for i, p in enumerate(ps, 1) if _contains(p["text"], it.evidence)), None))

    def rank_stats(rs: list[int | None]) -> dict[str, Any]:
        return {"n": len(rs), "recall@1": rate(sum(r == 1 for r in rs), len(rs)), "recall@3": rate(sum(r is not None for r in rs), len(rs))}

    out = {
        "n": len(variants["claim"]["hit"]),
        "skipped": skipped,
        "docs": len(docs),
        "pages": sum(len(cache[d][0]) for d in cache),
        "locate": {k: {m: _mean(v[m]) for m in v} for k, v in variants.items()},
        "locate_zh": {"n": len(zh_loc["hit"]), **{m: _mean(v) for m, v in zh_loc.items()}},
        "passages": rank_stats(ranks_en),
        "passages_zh": rank_stats(ranks_zh),
        "latency_p50_ms": pct(lat, 50),
        "latency_p95_ms": pct(lat, 95),
    }
    for f in tmp.glob("*.pdf"):
        f.unlink()
    tmp.rmdir()
    return out
