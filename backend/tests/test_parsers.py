"""PDF 解析器：GROBID 的 TEI、MinerU 的 content_list / Markdown 转成 (段落, 章节, 页码)；外部服务不可用时回退 PyMuPDF。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-parsers-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from app import parsers  # noqa: E402

LONG = "Retrieval-augmented generation retrieves documents from an external index before generating the answer."

TEI = f"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><profileDesc><abstract><div><p>
<s coords="1,50,100,300,10">We study {LONG}</s></p></div></abstract></profileDesc></teiHeader>
<text><body>
<div><head n="1" coords="1,50,300,200,12">Introduction</head>
<p><s coords="2,50,120,300,10">{LONG}</s> <s coords="2,50,130,300,10">It reduces hallucination.</s></p>
<formula xml:id="formula_0" coords="2,60,200,100,20">p(y|x) = sum_z p(z|x) p(y|x,z)</formula></div>
<div><head n="2">Method</head><p><s coords="3,50,100,300,10">{LONG} Dense retrieval.</s></p></div>
<div><head>References</head><p>{LONG} should not appear</p></div>
</body><back><div><listBibl><biblStruct/></listBibl></div></back></text></TEI>"""


def test_parse_tei_sections_pages_and_formulas():
    paras = parsers.parse_tei(TEI)
    assert paras[0][1] == "Abstract" and paras[0][2] == 1
    intro = [p for p in paras if p[1] == "1 Introduction"]
    assert intro[0][2] == 2 and "hallucination" in intro[0][0]
    assert any(p[0].startswith("p(y|x)") for p in intro)  # 公式单独成段
    assert paras[-1][1] == "2 Method" and paras[-1][2] == 3
    assert not any("should not appear" in p[0] for p in paras)  # 参考文献之后不要


def test_parse_mineru_content_list():
    items = [
        {"type": "text", "text": "摘要", "text_level": 1, "page_idx": 0},
        {"type": "text", "text": "检索增强生成在生成答案之前先检索外部知识，从而减少大语言模型的事实错误，这是本文的出发点。", "page_idx": 0},
        {"type": "text", "text": "1 方法", "text_level": 1, "page_idx": 1},
        {"type": "equation", "text": "$$p(y|x)=\\sum_z p(z|x)$$", "page_idx": 1},
        {"type": "table", "table_caption": ["表 1 结果"], "table_body": "<table><tr><td>方法</td><td>准确率 0.91</td></tr></table>", "page_idx": 2},
        {"type": "image", "img_path": "a.jpg", "page_idx": 2},
        {"type": "text", "text": "参考文献", "text_level": 1, "page_idx": 3},
        {"type": "text", "text": "[1] 这一条是参考文献，不应该出现在检索内容里，长度超过三十个字符。", "page_idx": 3},
    ]
    paras = parsers.parse_content_list(items)
    assert paras[0] == (items[1]["text"], "摘要", 1)
    assert paras[1][0].startswith("$$") and paras[1][1:] == ("1 方法", 2)
    assert "准确率 0.91" in paras[2][0] and paras[2][2] == 3
    assert len(paras) == 3


def test_parse_markdown_with_pages():
    md = f"# 1 Introduction\n\n{LONG}\n\n![](images/a.jpg)\n\n## 2 Method\n\nDense retrieval maps questions and passages into the same vector space.\n\n# References\n\n{LONG}"
    pages = [LONG, "Dense retrieval maps questions and passages into the same vector space."]
    paras = parsers.parse_markdown(md, pages)
    assert paras == [(LONG, "1 Introduction", 1), ("Dense retrieval maps questions and passages into the same vector space.", "2 Method", 2)]


def test_fallback_to_pymupdf_when_service_down(monkeypatch, tmp_path):
    import fitz

    pdf = tmp_path / "a.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "1 Introduction", fontsize=12)
    page.insert_text((72, 100), LONG[:80], fontsize=10)
    page.insert_text((72, 114), LONG[80:] + " More words here to pass length.", fontsize=10)
    doc.save(str(pdf))

    s = parsers.get_settings()
    monkeypatch.setattr(parsers, "get_settings", lambda: s.__class__(**{**s.__dict__, "pdf_parser": "grobid", "grobid_url": "http://127.0.0.1:9"}))
    paras, used, note = parsers.parse_pdf(pdf)
    assert used == "pymupdf" and "GROBID" in note and paras

    # 服务正常时使用 GROBID 的结果
    class R:
        status_code = 200
        text = TEI

    monkeypatch.setattr(httpx, "post", lambda *a, **kw: R())
    paras, used, note = parsers.parse_pdf(pdf)
    assert used == "grobid" and note is None and paras[0][1] == "Abstract"
