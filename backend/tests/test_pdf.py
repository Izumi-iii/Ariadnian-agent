"""PDF 阅读：原文文件、依据定位、相关段落、预览缓存。全部离线。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import httpx
import pytest

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-pdf-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import pdfview, scholar, security  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

PAGE1 = (
    "1 Introduction\n\nLarge pre-trained language models store factual knowledge in their parameters, "
    "but their ability to access and precisely manipulate knowledge is still limited. "
    "Hallucinated facts remain a serious problem for knowledge-intensive tasks such as open-domain question answering."
)
PAGE2 = (
    "3 Methods\n\nWe combine a pre-trained retriever with a pre-trained seq2seq generator and fine-tune end-to-end. "
    "For query x, we use Maximum Inner Product Search to find the top-K documents. "
    "For final prediction y, we treat the retrieved document z as a latent variable and marginalize over "
    "seq2seq predictions given different documents. This marginalization lets the generator combine evidence."
)


def make_pdf(path: Path) -> Path:
    import fitz

    doc = fitz.open()
    for body in (PAGE1, PAGE2):
        page = doc.new_page(width=595, height=842)
        # 窄文本框：句子会跨行，覆盖「整句找不到 → 分段查找」的情况
        page.insert_textbox(fitz.Rect(60, 60, 330, 780), body, fontsize=10.5, fontname="helv")
    doc.save(str(path))
    return path


@pytest.fixture(scope="module")
def paper_id() -> str:
    pdf = make_pdf(Path(tempfile.mkdtemp()) / "rag.pdf")
    r = client.post("/api/papers/upload", files={"file": ("rag.pdf", pdf.read_bytes(), "application/pdf")})
    assert r.status_code == 200, r.text
    return r.json()["paper"]["id"]


def test_library_pdf_served(paper_id):
    p = client.get(f"/api/papers").json()
    assert next(x for x in p if x["id"] == paper_id)["has_pdf"] is True
    r = client.get(f"/api/pdf/file?paper_id={paper_id}")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-")


def test_bad_ids_rejected():
    assert client.get("/api/pdf/file?paper_id=..%2F..%2Fsettings").status_code == 404
    assert client.get("/api/pdf/file?paper_id=nope").status_code == 404
    assert client.get("/api/pdf/file").status_code == 404
    assert pdfview.library_pdf("../x") is None


def test_locate_picks_relevant_sentence(paper_id):
    chunks = client.get(f"/api/papers/{paper_id}/chunks").json()
    snippet = next(c for c in chunks if "latent variable" in c["text"])
    r = client.post("/api/pdf/locate", json={
        "paper_id": paper_id, "text": snippet["text"], "page": snippet["page"],
        "claim": "RAG treats the retrieved document as a latent variable and marginalizes over it",
    }).json()
    assert r["found"] and r["page"] == 2
    assert "latent variable" in r["quote"]
    assert r["rects"] and all(0 <= v <= 1 for rect in r["rects"] for v in rect)
    # 高亮跨了不止一行（句子被窄文本框折行）
    assert len({round(rect[1], 2) for rect in r["rects"]}) >= 2


def test_locate_without_claim_and_wrong_page(paper_id):
    r = client.post("/api/pdf/locate", json={"paper_id": paper_id, "text": PAGE1.split("\n\n")[1], "page": 2}).json()
    assert r["found"] and r["page"] == 1  # 页码给错了也能在附近找到


def test_passages_rank_by_claim(paper_id):
    r = client.post("/api/pdf/passages", json={"paper_id": paper_id, "claim": "marginalize over latent retrieved documents"}).json()
    assert r["passages"] and r["passages"][0]["page"] == 2
    assert "marginalize" in r["passages"][0]["text"]


def test_preview_by_url_is_cached_and_reused(monkeypatch, tmp_path):
    pdf_bytes = make_pdf(tmp_path / "p.pdf").read_bytes()
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        return httpx.Response(200, content=pdf_bytes, headers={"content-type": "application/pdf"})

    monkeypatch.setattr(security.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    monkeypatch.setattr(scholar, "_TRANSPORT", httpx.MockTransport(handler))
    url = "https://papers.example/rag-preview.pdf"
    r = client.get("/api/pdf/file", params={"url": url})
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")
    client.get("/api/pdf/file", params={"url": url})
    assert len(calls) == 1  # 第二次走缓存
    # 预览不会写进文献库；加入文献库后下载全文直接复用缓存
    added = client.post("/api/papers", json={"title": "Preview Paper", "pdf_url": url}).json()["paper"]
    assert added["has_pdf"] is False
    r = client.post(f"/api/papers/{added['id']}/fulltext")
    assert r.status_code == 200 and r.json()["paper"]["has_pdf"] is True
    assert len(calls) == 1
    # 删除文献时原文一起删掉
    assert client.delete(f"/api/papers/{added['id']}").status_code == 200
    assert pdfview.library_pdf(added["id"]) is None


def test_preview_rejects_private_and_non_pdf(monkeypatch):
    assert client.get("/api/pdf/file", params={"url": "http://127.0.0.1:8000/x.pdf"}).status_code == 400
    monkeypatch.setattr(security.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    monkeypatch.setattr(scholar, "_TRANSPORT", httpx.MockTransport(lambda req: httpx.Response(200, content=b"<html>landing page</html>")))
    r = client.get("/api/pdf/file", params={"url": "https://papers.example/landing"})
    assert r.status_code == 422 and "不是 PDF" in r.json()["detail"]


def test_two_column_reading_order(tmp_path):
    import fitz

    from app.ingest import extract_pdf_pages, split_paragraphs

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_textbox(fitz.Rect(54, 50, 541, 80), "A Two Column Paper Title", fontsize=14, align=1)
    left = "Left column first paragraph talks about dense retrievers and how questions are encoded. " * 3
    right = "Right column paragraph discusses generators and marginalization over latent documents. " * 3
    page.insert_textbox(fitz.Rect(54, 100, 288, 400), left, fontsize=10)
    page.insert_textbox(fitz.Rect(307, 100, 541, 400), right, fontsize=10)
    path = tmp_path / "two.pdf"
    doc.save(str(path))
    paras = [t for t, _, _ in split_paragraphs(extract_pdf_pages(path))]
    # 左右两栏不会交错拼接：左栏整段在前，右栏整段在后
    assert any(t.startswith("Left column") and "Right column" not in t for t in paras)
    assert any(t.startswith("Right column") and "Left column" not in t for t in paras)
    li = next(i for i, t in enumerate(paras) if t.startswith("Left"))
    ri = next(i for i, t in enumerate(paras) if t.startswith("Right"))
    assert li < ri
