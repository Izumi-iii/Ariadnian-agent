from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..export_docx import CSL, PandocMissing, to_docx

router = APIRouter(prefix="/api/export", tags=["export"])

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class DocxIn(BaseModel):
    markdown: str = Field(..., max_length=2_000_000)
    title: str = "论文"
    paper_ids: list[str] = Field(default_factory=list)
    style: str = "gbt-numeric"  # gbt-numeric / gbt-author-date / apa


@router.post("/docx")
def export_docx(body: DocxIn):
    if body.style not in CSL:
        raise HTTPException(422, f"不支持的引用格式：{body.style}")
    try:
        data = to_docx(body.markdown, body.paper_ids, body.style)
    except PandocMissing as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, str(e)) from e
    name = (body.title.strip() or "论文")[:80] + ".docx"
    return Response(data, media_type=DOCX, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


@router.get("/docx/status")
def docx_status():
    """前端据此决定 Word 导出是否可用"""
    try:
        from ..export_docx import pandoc_path

        pandoc_path()
        return {"ok": True}
    except PandocMissing as e:
        return {"ok": False, "message": str(e)}
