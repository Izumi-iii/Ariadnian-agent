from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse

from .. import pdfview, scholar
from ..config import get_settings
from ..db import get_conn
from ..ingest import chunk_plain_text, guess_pdf_metadata, index_abstract, index_pdf, store_chunks
from ..library import PaperIn, add_paper, bibtex_for, delete_paper, get_paper, list_papers, update_paper
from ..security import UnsafeURL, max_upload_bytes

router = APIRouter(prefix="/api/papers", tags=["papers"])


@router.get("")
def papers_list():
    return list_papers()


@router.get("/external")
def papers_external(q: str = Query(..., min_length=2), sources: str = "semantic_scholar,arxiv", limit: int = 8):
    results, errors = scholar.search(q, [s for s in sources.split(",") if s], limit=limit)
    return {"results": [r.model_dump() for r in results], "errors": errors}


@router.get("/bibtex", response_class=PlainTextResponse)
def papers_bibtex(ids: str | None = None):
    return bibtex_for(ids.split(",") if ids else None)


@router.post("")
def papers_add(p: PaperIn):
    paper, created = add_paper(p)
    index_abstract(paper.id, paper.title, paper.abstract)
    return {"paper": get_paper(paper.id), "created": created}


@router.patch("/{pid}")
def papers_update(pid: str, fields: dict):
    paper = update_paper(pid, fields)
    if not paper:
        raise HTTPException(404, "文献不存在")
    return paper


@router.delete("/{pid}")
def papers_delete(pid: str):
    if not delete_paper(pid):
        raise HTTPException(404, "文献不存在")
    from ..retrieval import invalidate_index

    invalidate_index()
    return {"ok": True}


@router.get("/{pid}/chunks")
def papers_chunks(pid: str, limit: int = 50):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, idx, section, page, text FROM chunks WHERE paper_id=? ORDER BY idx LIMIT ?", (pid, limit)
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/upload")
async def papers_upload(file: UploadFile = File(...), paper_id: str | None = Form(None)):
    """上传 PDF / TXT / MD。带 paper_id 时作为已有文献的全文，否则新建文献条目。"""
    name = file.filename or "upload"
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".txt", ".md", ".markdown"}:
        raise HTTPException(400, "目前支持 PDF / TXT / Markdown")
    pdf_dir = get_settings().data_dir / "pdfs"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    limit = max_upload_bytes()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:  # 跨平台临时文件（修复旧版 /tmp 路径问题）
        tmp_path = Path(tmp.name)
        size = 0
        while block := file.file.read(1024 * 1024):
            size += len(block)
            if size > limit:
                tmp.close()
                tmp_path.unlink(missing_ok=True)
                raise HTTPException(413, f"文件超过 {limit // (1024 * 1024)} MB 上限")
            tmp.write(block)
    try:
        if paper_id:
            paper = get_paper(paper_id)
            if not paper:
                raise HTTPException(404, "文献不存在")
        else:
            meta = guess_pdf_metadata(tmp_path) if suffix == ".pdf" else {"title": Path(name).stem, "authors": []}
            paper, _ = add_paper(PaperIn(title=meta["title"], authors=meta["authors"], source="upload"))
        if suffix == ".pdf":
            dest = pdf_dir / f"{paper.id}.pdf"
            shutil.copy(tmp_path, dest)
            n = index_pdf(paper.id, dest)
        else:
            text = tmp_path.read_text(encoding="utf-8", errors="ignore")
            n = store_chunks(paper.id, chunk_plain_text(text), fulltext=True)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    finally:
        tmp_path.unlink(missing_ok=True)
    return {"paper": get_paper(paper.id), "chunks": n}


@router.post("/{pid}/fulltext")
def papers_fetch_fulltext(pid: str):
    paper = get_paper(pid)
    if not paper:
        raise HTTPException(404, "文献不存在")
    if not paper.pdf_url:
        raise HTTPException(400, "这篇文献没有开放获取的 PDF 链接，可以手动上传")
    try:
        path = pdfview.fetch_into_library(pid, paper.pdf_url)
        n = index_pdf(pid, path)
    except UnsafeURL as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"下载或解析失败：{e}") from e
    return {"paper": get_paper(pid), "chunks": n}
