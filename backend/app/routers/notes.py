"""PDF 笔记：在原文上划线（高亮）并写批注。笔记属于文献库里的论文，写作时可以用 @ 引用（带页码）。

    GET    /api/notes?paper_id=...   某篇论文的笔记；不带参数返回全部
    POST   /api/notes                新建（划线 / 记笔记）
    PATCH  /api/notes/{id}           修改批注或颜色
    DELETE /api/notes/{id}
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from ..db import get_conn
from ..library import get_paper

router = APIRouter(prefix="/api/notes", tags=["notes"])

COLORS = {"yellow", "green", "blue", "pink"}


class NoteIn(BaseModel):
    paper_id: str
    page: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=4000)
    comment: str = Field(default="", max_length=4000)
    rects: list[list[float]] = Field(default_factory=list, max_length=200)
    color: str = "yellow"

    @field_validator("rects")
    @classmethod
    def _rects(cls, v: list[list[float]]) -> list[list[float]]:
        for r in v:
            if len(r) != 4 or not all(-0.01 <= x <= 1.01 for x in r):
                raise ValueError("rects 需要是 [x0, y0, x1, y1]，取值 0~1")
        return [[round(x, 4) for x in r] for r in v]

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        return v if v in COLORS else "yellow"


class NotePatch(BaseModel):
    comment: str | None = Field(default=None, max_length=4000)
    color: str | None = None


def _row(r) -> dict:
    d = dict(r)
    d["rects"] = json.loads(d["rects"] or "[]")
    return d


def _get(nid: str) -> dict | None:
    with get_conn() as conn:
        r = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    return _row(r) if r else None


@router.get("")
def notes_list(paper_id: str | None = None):
    with get_conn() as conn:
        if paper_id:
            rows = conn.execute("SELECT * FROM notes WHERE paper_id=? ORDER BY page, created_at", (paper_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM notes ORDER BY updated_at DESC").fetchall()
    return [_row(r) for r in rows]


@router.post("")
def notes_create(body: NoteIn):
    if not get_paper(body.paper_id):
        raise HTTPException(404, "文献不存在")
    nid = uuid.uuid4().hex[:12]
    quote = " ".join(body.quote.split())
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO notes (id, paper_id, page, quote, comment, rects, color) VALUES (?,?,?,?,?,?,?)",
            (nid, body.paper_id, body.page, quote, body.comment.strip(), json.dumps(body.rects), body.color),
        )
    return _get(nid)


@router.patch("/{nid}")
def notes_update(nid: str, body: NotePatch):
    if not _get(nid):
        raise HTTPException(404, "笔记不存在")
    sets, vals = [], []
    if body.comment is not None:
        sets.append("comment=?")
        vals.append(body.comment.strip())
    if body.color is not None:
        sets.append("color=?")
        vals.append(body.color if body.color in COLORS else "yellow")
    if sets:
        with get_conn() as conn:
            conn.execute(f"UPDATE notes SET {', '.join(sets)}, updated_at=datetime('now') WHERE id=?", (*vals, nid))
    return _get(nid)


@router.delete("/{nid}")
def notes_delete(nid: str):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM notes WHERE id=?", (nid,))
    if not cur.rowcount:
        raise HTTPException(404, "笔记不存在")
    return {"ok": True}
