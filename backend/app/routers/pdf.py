"""PDF 阅读接口：原文文件、依据定位、相关段落。

    GET  /api/pdf/file?paper_id=...      文献库论文的 PDF
    GET  /api/pdf/file?url=...           还没入库的论文：临时下载预览（缓存在 data/pdf_cache，不写入文献库）
    POST /api/pdf/locate                 在原文中找到依据句，返回页码和高亮矩形
    POST /api/pdf/passages               与论断最相关的几段原文
"""
from __future__ import annotations

from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import pdfview
from ..library import get_paper
from ..security import UnsafeURL

router = APIRouter(prefix="/api/pdf", tags=["pdf"])


def _resolve(paper_id: str | None, url: str | None) -> Path:
    if paper_id and not get_paper(paper_id):
        raise HTTPException(404, "文献不存在")
    try:
        return pdfview.resolve(paper_id, url)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except UnsafeURL as e:
        raise HTTPException(400, str(e)) from e
    except ValueError as e:  # 不是 PDF、超过大小上限
        raise HTTPException(422, str(e)) from e
    except httpx.HTTPError as e:
        raise HTTPException(502, f"下载 PDF 失败：{e}") from e


@router.get("/file")
def pdf_file(paper_id: str | None = None, url: str | None = None):
    path = _resolve(paper_id, url)
    name = f"{paper_id or 'preview'}.pdf"
    return FileResponse(path, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{name}"',
                                                                     "Cache-Control": "private, max-age=3600"})


class LocateIn(BaseModel):
    paper_id: str | None = None
    url: str | None = None
    text: str
    page: int | None = None
    claim: str = ""


@router.post("/locate")
def pdf_locate(body: LocateIn):
    if not body.text.strip():
        raise HTTPException(400, "缺少要定位的原文")
    return pdfview.locate(_resolve(body.paper_id, body.url), body.text, body.page, body.claim)


class PassagesIn(BaseModel):
    paper_id: str | None = None
    url: str | None = None
    claim: str
    k: int = 3


@router.post("/passages")
def pdf_passages(body: PassagesIn):
    return {"passages": pdfview.passages(_resolve(body.paper_id, body.url), body.claim, max(1, min(body.k, 8)))}
