"""文献库：论文元数据的增删查、去重、BibTeX 生成。"""
from __future__ import annotations

import json
import re
import unicodedata
import uuid
from typing import Any

from pydantic import BaseModel, Field

from .db import get_conn


class PaperIn(BaseModel):
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    url: str | None = None
    pdf_url: str | None = None
    abstract: str | None = None
    source: str | None = None
    citation_count: int | None = None


class Paper(PaperIn):
    id: str
    bibkey: str
    has_fulltext: bool = False
    has_pdf: bool = False  # data/pdfs 里有原文 PDF，可以在「原文」里阅读
    chunk_count: int = 0
    created_at: str | None = None


_STOPWORDS = {"a", "an", "the", "on", "of", "for", "in", "to", "and", "with", "towards", "via", "is", "are"}


def normalize_title(title: str) -> str:
    t = unicodedata.normalize("NFKC", title).lower()
    return re.sub(r"[^\w]+", "", t)


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def make_bibkey(authors: list[str], year: int | None, title: str) -> str:
    last = "anon"
    if authors:
        first = authors[0].strip()
        if "," in first:
            last = first.split(",")[0]
        else:
            parts = first.split()
            last = parts[-1] if parts else first
        last = re.sub(r"[^a-z]", "", _ascii(last).lower()) or "anon"
    word = "paper"
    for w in re.findall(r"[A-Za-z]+", _ascii(title)):
        if w.lower() not in _STOPWORDS:
            word = w.lower()
            break
    return f"{last}{year or ''}{word}"


def _row_to_paper(row: Any, chunk_count: int = 0) -> Paper:
    d = dict(row)
    d["authors"] = json.loads(d.get("authors") or "[]")
    d["has_fulltext"] = bool(d.get("has_fulltext"))
    d["chunk_count"] = d.pop("chunk_count", chunk_count) or 0
    from .pdfview import library_pdf

    d["has_pdf"] = library_pdf(d["id"]) is not None
    return Paper(**d)


def find_duplicate(p: PaperIn) -> Paper | None:
    with get_conn() as conn:
        if p.doi:
            row = conn.execute("SELECT * FROM papers WHERE lower(doi)=lower(?)", (p.doi,)).fetchone()
            if row:
                return _row_to_paper(row)
        if p.arxiv_id:
            base = p.arxiv_id.split("v")[0]
            row = conn.execute("SELECT * FROM papers WHERE arxiv_id LIKE ?", (base + "%",)).fetchone()
            if row:
                return _row_to_paper(row)
        norm = normalize_title(p.title)
        for row in conn.execute("SELECT * FROM papers"):
            if normalize_title(row["title"]) == norm:
                return _row_to_paper(row)
    return None


def add_paper(p: PaperIn) -> tuple[Paper, bool]:
    """加入文献库；已存在则返回已有条目。返回 (paper, created)。"""
    dup = find_duplicate(p)
    if dup:
        return dup, False
    pid = uuid.uuid4().hex[:12]
    base_key = make_bibkey(p.authors, p.year, p.title)
    with get_conn() as conn:
        key, n = base_key, 1
        while conn.execute("SELECT 1 FROM papers WHERE bibkey=?", (key,)).fetchone():
            key = f"{base_key}{chr(ord('a') + n)}"
            n += 1
        conn.execute(
            """INSERT INTO papers (id, bibkey, title, authors, year, venue, doi, arxiv_id, url, pdf_url,
                                   abstract, source, citation_count)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                pid, key, p.title.strip(), json.dumps(p.authors, ensure_ascii=False), p.year, p.venue,
                p.doi, p.arxiv_id, p.url, p.pdf_url, p.abstract, p.source, p.citation_count,
            ),
        )
    paper = get_paper(pid)
    assert paper
    return paper, True


def get_paper(pid: str) -> Paper | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT p.*, (SELECT count(*) FROM chunks c WHERE c.paper_id=p.id) AS chunk_count FROM papers p WHERE id=?",
            (pid,),
        ).fetchone()
    return _row_to_paper(row) if row else None


def list_papers() -> list[Paper]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT p.*, (SELECT count(*) FROM chunks c WHERE c.paper_id=p.id) AS chunk_count "
            "FROM papers p ORDER BY created_at DESC"
        ).fetchall()
    return [_row_to_paper(r) for r in rows]


def update_paper(pid: str, fields: dict[str, Any]) -> Paper | None:
    allowed = {"title", "authors", "year", "venue", "doi", "url", "pdf_url", "abstract", "bibkey"}
    sets, vals = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "authors":
            v = json.dumps(v, ensure_ascii=False)
        sets.append(f"{k}=?")
        vals.append(v)
    if sets:
        with get_conn() as conn:
            conn.execute(f"UPDATE papers SET {', '.join(sets)} WHERE id=?", (*vals, pid))
    return get_paper(pid)


def delete_paper(pid: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM papers WHERE id=?", (pid,))
    if cur.rowcount > 0:
        from .pdfview import library_pdf

        pdf = library_pdf(pid)
        if pdf:
            pdf.unlink(missing_ok=True)
    return cur.rowcount > 0


def _bib_escape(s: str) -> str:
    return s.replace("&", r"\&").replace("%", r"\%").replace("_", r"\_").replace("#", r"\#")


def to_bibtex(p: Paper) -> str:
    entry_type = "article" if p.venue and not p.arxiv_id else ("misc" if p.arxiv_id and not p.venue else "inproceedings")
    if p.venue and re.search(r"journal|transactions|letters|review", p.venue, re.I):
        entry_type = "article"
    fields: list[tuple[str, str]] = [("title", "{" + _bib_escape(p.title) + "}")]
    if p.authors:
        fields.append(("author", " and ".join(p.authors)))
    if p.year:
        fields.append(("year", str(p.year)))
    if p.venue:
        fields.append(("journal" if entry_type == "article" else "booktitle", _bib_escape(p.venue)))
    if p.arxiv_id:
        fields += [("eprint", p.arxiv_id), ("archivePrefix", "arXiv")]
    if p.doi:
        fields.append(("doi", p.doi))
    if p.url:
        fields.append(("url", p.url))
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields)
    return f"@{entry_type}{{{p.bibkey},\n{body}\n}}"


def bibtex_for(ids: list[str] | None = None) -> str:
    papers = list_papers()
    if ids is not None:
        order = {pid: i for i, pid in enumerate(ids)}
        papers = sorted((p for p in papers if p.id in order), key=lambda p: order[p.id])
    return "\n\n".join(to_bibtex(p) for p in papers) + "\n"
