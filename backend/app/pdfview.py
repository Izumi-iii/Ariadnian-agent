"""PDF 阅读：提供原文文件、在原文里定位引用依据、找出与论断最相关的段落。

两种来源：
- 文献库里的论文：data/pdfs/<paper_id>.pdf（下载全文或上传后才有）
- 还没入库的论文（检索结果、Agent 候选）：按 pdf_url 下载到 data/pdf_cache/ 临时预览，
  不写入文献库；之后真正加入文献库时直接复用这份缓存，不用再下载一次。
"""
from __future__ import annotations

import hashlib
import re
import shutil
from functools import lru_cache
from pathlib import Path

from .config import get_settings

CACHE_LIMIT = 40  # 预览缓存最多保留的文件数，超出时删掉最久没用的
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def pdf_dir() -> Path:
    return get_settings().data_dir / "pdfs"


def cache_dir() -> Path:
    return get_settings().data_dir / "pdf_cache"


def library_pdf(paper_id: str) -> Path | None:
    """文献库论文的本地 PDF；id 只允许字母数字，杜绝路径穿越。"""
    if not _ID.match(paper_id or ""):
        return None
    p = pdf_dir() / f"{paper_id}.pdf"
    return p if p.is_file() else None


def _cache_path(url: str) -> Path:
    return cache_dir() / (hashlib.sha1(url.encode()).hexdigest()[:24] + ".pdf")


def _prune_cache() -> None:
    files = sorted(cache_dir().glob("*.pdf"), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in files[CACHE_LIMIT:]:
        f.unlink(missing_ok=True)


def cached_pdf(url: str) -> Path:
    """临时预览：下载（或复用缓存）指定链接的 PDF。地址安全检查和大小限制在 download_pdf 里。"""
    from . import scholar

    dest = _cache_path(url)
    if dest.is_file():
        dest.touch()
        return dest
    scholar.download_pdf(url, dest)
    _prune_cache()
    return dest


def fetch_into_library(paper_id: str, url: str) -> Path:
    """把论文 PDF 放进文献库：预览过就直接用缓存，否则下载。"""
    from . import scholar

    dest = pdf_dir() / f"{paper_id}.pdf"
    cached = _cache_path(url)
    if cached.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cached, dest)
        return dest
    return scholar.download_pdf(url, dest)


def resolve(paper_id: str | None = None, url: str | None = None) -> Path:
    if paper_id:
        p = library_pdf(paper_id)
        if p:
            return p
        if not url:
            raise FileNotFoundError("这篇文献还没有本地 PDF")
    if url:
        return cached_pdf(url)
    raise FileNotFoundError("缺少 paper_id 或 url")


# ---------------------------------------------------------------------------
# 论断 → 检索词（中文论断会扩展英文关键词；同一句话只算一次）
# ---------------------------------------------------------------------------
@lru_cache(maxsize=256)
def _claim_terms(claim: str) -> frozenset[str]:
    from .assist import retrieval_query
    from .retrieval import tokenize

    if not claim.strip():
        return frozenset()
    try:
        q = retrieval_query(claim)
    except Exception:  # noqa: BLE001  扩展失败时只用原句
        q = claim
    return frozenset(tokenize(q))


_SENT = re.compile(r"(?<=[.!?。！？])\s+")


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT.split(re.sub(r"\s+", " ", text)) if len(s.strip()) > 1]


def pick_quote(text: str, claim: str = "", max_chars: int = 320) -> str:
    """从依据片段（通常是一整块）里挑出与论断最相关的一两句，用来高亮。"""
    from .retrieval import tokenize

    sents = _sentences(text)
    if not sents:
        return text.strip()[:max_chars]
    terms = _claim_terms(claim)
    if terms:
        scored = [(len(terms & set(tokenize(s))), -i, i) for i, s in enumerate(sents)]
        best = max(scored)[2]
    else:
        best = 0
    quote = sents[best]
    # 太短的句子（比如只有半句）带上下一句
    if len(quote) < 80 and best + 1 < len(sents):
        quote = f"{quote} {sents[best + 1]}"
    return quote[:max_chars]


# ---------------------------------------------------------------------------
# 在 PDF 页面上定位一段文字，返回归一化的矩形（0~1，相对页面宽高）
# ---------------------------------------------------------------------------
def _windows(words: list[str], size: int = 6) -> list[str]:
    out = []
    for i in range(0, len(words), size):
        w = words[i : i + size]
        if len(w) >= 3 or not out:
            out.append(" ".join(w))
        else:
            out[-1] += " " + " ".join(w)
    return out


def _find_on_page(page, quote: str) -> list[tuple[float, float, float, float]]:
    hits = page.search_for(quote)
    if hits:
        return [(r.x0, r.y0, r.x1, r.y1) for r in hits]
    # 整句找不到（换行断词、连字符、公式等）：按 6 个词一段分别找，按阅读顺序串起来
    rects: list[tuple[float, float, float, float]] = []
    last_y = -1.0
    found = 0
    wins = _windows(quote.split())
    for w in wins:
        cands = page.search_for(w)
        if not cands:
            continue
        # 优先取在上一段之后的匹配，避免跳到页面别处同样的词组
        after = [r for r in cands if r.y0 >= last_y - 2]
        r = (after or cands)[0]
        rects.append((r.x0, r.y0, r.x1, r.y1))
        last_y = r.y0
        found += 1
    return rects if wins and found / len(wins) >= 0.4 else []


def _merge_lines(rects: list[tuple[float, float, float, float]]) -> list[tuple[float, float, float, float]]:
    """同一行上相邻的小矩形合成一个，高亮更整齐"""
    out: list[list[float]] = []
    for r in sorted(rects, key=lambda r: (round(r[1]), r[0])):
        if out and abs(out[-1][1] - r[1]) < 3 and r[0] - out[-1][2] < 12:
            out[-1][2] = max(out[-1][2], r[2])
            out[-1][3] = max(out[-1][3], r[3])
        else:
            out.append(list(r))
    return [tuple(r) for r in out]  # type: ignore[misc]


def locate(path: Path, text: str, page: int | None = None, claim: str = "") -> dict:
    """在 PDF 里找到 text（依据片段）中与 claim 最相关的那句话。页码从 1 开始。"""
    import fitz

    quote = pick_quote(text, claim)
    with fitz.open(str(path)) as doc:
        n = len(doc)
        if page and 1 <= page <= n:
            order = [page, page + 1, page - 1] + [p for p in range(1, n + 1) if p not in (page, page + 1, page - 1)]
        else:
            order = list(range(1, n + 1))
        order = [p for p in order if 1 <= p <= n][:40]
        for p in order:
            pg = doc[p - 1]
            rects = _find_on_page(pg, quote)
            if rects:
                w, h = pg.rect.width, pg.rect.height
                norm = [[round(x0 / w, 4), round(y0 / h, 4), round(x1 / w, 4), round(y1 / h, 4)] for x0, y0, x1, y1 in _merge_lines(rects)]
                return {"page": p, "rects": norm, "quote": quote, "found": True, "pages": n}
    return {"page": page if page and 1 <= page <= n else 1, "rects": [], "quote": quote, "found": False, "pages": n}


# ---------------------------------------------------------------------------
# 与论断最相关的段落（预览窗口右侧的「最相关的原文」）
# ---------------------------------------------------------------------------
def passages(path: Path, claim: str, k: int = 3) -> list[dict]:
    """按与论断的词重合打分（tf 取对数，词按稀有程度加权）。单篇论文段落少，BM25 的 idf 在小语料上会退化成 0，这里不用它。"""
    import math
    from collections import Counter

    from .ingest import extract_pdf_pages, split_paragraphs
    from .retrieval import tokenize

    paras = split_paragraphs(extract_pdf_pages(path))
    if not paras:
        return []
    terms = _claim_terms(claim)
    if not terms:
        return [{"page": pg, "section": sec, "text": t[:600], "score": 0.0} for t, sec, pg in paras[:k]]
    docs = [Counter(tokenize(t)) for t, _, _ in paras]
    n = len(docs)
    df = Counter(w for d in docs for w in set(d) if w in terms)
    scores = []
    for d in docs:
        sc = sum((1 + math.log(d[w])) * math.log(1 + n / df[w]) for w in terms if d.get(w))
        scores.append(sc / (1 + math.log(1 + sum(d.values())) * 0.1))
    order = sorted(range(n), key=lambda i: -scores[i])
    out = []
    for i in order[:k]:
        if scores[i] <= 0 and out:
            break
        t, sec, pg = paras[i]
        out.append({"page": pg, "section": sec, "text": t[:600], "score": round(scores[i], 3)})
    return out
