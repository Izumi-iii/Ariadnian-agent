"""Word 导出：pandoc + citeproc，参考文献按 GB/T 7714 / APA 排版，带页码的引用。"""
from __future__ import annotations

import io
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-export-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.export_docx import PandocMissing, pandoc_path  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

try:
    pandoc_path()
    HAS_PANDOC = True
except PandocMissing:
    HAS_PANDOC = False


def _text(docx: bytes) -> str:
    xml = zipfile.ZipFile(io.BytesIO(docx)).read("word/document.xml").decode()
    return re.sub(r"<[^>]+>", "", xml)


@pytest.mark.skipif(not HAS_PANDOC, reason="没有 pandoc")
def test_docx_with_gbt_references():
    p = client.post("/api/papers", json={"title": "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
                                        "authors": ["Patrick Lewis", "Ethan Perez"], "year": 2020, "venue": "NeurIPS"}).json()["paper"]
    md = f'---\ntitle: "引用核查助手"\n---\n\n# 引言\n\n检索增强生成可以减少事实错误[@{p["bibkey"]}, p. 3]。\n'
    r = client.post("/api/export/docx", json={"markdown": md, "title": "引用核查助手", "paper_ids": [p["id"]], "style": "gbt-numeric"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert "filename*=UTF-8''" in r.headers["content-disposition"]
    text = _text(r.content)
    assert "引用核查助手" in text and "参考文献" in text
    assert "Retrieval-Augmented Generation" in text  # 文末参考文献
    assert "[1]" in text  # 顺序编码
    assert "@" not in text  # 引用标记全部被 citeproc 处理掉

    r = client.post("/api/export/docx", json={"markdown": md, "paper_ids": [p["id"]], "style": "apa"})
    assert r.status_code == 200 and "Lewis" in _text(r.content)


def test_docx_rejects_unknown_style():
    assert client.post("/api/export/docx", json={"markdown": "x", "style": "mla"}).status_code == 422
