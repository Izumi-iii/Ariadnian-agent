"""PDF 全文解析器：默认 PyMuPDF（零依赖），可选 GROBID / MinerU（解析质量更高，需要另外部署服务）。

三者输出同一种结构：[(段落, 所在章节, 页码)]，到参考文献为止，交给 ingest.chunk_paragraphs 切块。
外部服务不可用或解析失败时自动退回 PyMuPDF，保证上传永远能成功。

- GROBID（https://github.com/kermitt2/grobid）：擅长英文学术论文，章节、段落、公式结构准确，
  请求时打开句子级坐标（teiCoordinates=s），据此得到段落所在页码；
- MinerU（https://github.com/opendatalab/MinerU）：擅长中文、扫描件（OCR）、复杂版式和公式，
  兼容两代接口：2.x 的 POST /file_parse（content_list 带页码）和 4.x 的 POST /v1/file_parse。
"""
from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

Para = tuple[str, "str | None", int]  # (段落, 章节, 页码)
PARSERS = ("pymupdf", "grobid", "mineru")
_REF_TITLE = re.compile(r"^\s*(?:\d+\.?\s*)?(?:References|REFERENCES|Bibliography|参考文献)\s*$")
_TEI = {"tei": "http://www.tei-c.org/ns/1.0"}


# ---------------------------------------------------------------------------
# GROBID
# ---------------------------------------------------------------------------
def _text(el: ET.Element) -> str:
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip()


def _page_of(el: ET.Element) -> int | None:
    """coords="页,x,y,w,h;..." —— 取第一个坐标的页码"""
    for node in [el, *el.iter()]:
        c = node.get("coords")
        if c:
            try:
                return int(c.split(";")[0].split(",")[0])
            except ValueError:
                return None
    return None


def parse_tei(tei: str) -> list[Para]:
    root = ET.fromstring(tei)
    out: list[Para] = []
    last_page = 1
    for p in root.findall(".//tei:teiHeader//tei:abstract//tei:p", _TEI):
        t = _text(p)
        if len(t) > 30:
            page = _page_of(p) or 1
            out.append((t, "Abstract", page))
            last_page = page
    body = root.find(".//tei:text/tei:body", _TEI)
    if body is None:
        return out
    for div in body.findall("tei:div", _TEI):
        head = div.find("tei:head", _TEI)
        section = None
        if head is not None and _text(head):
            n = head.get("n")
            section = f"{n} {_text(head)}" if n else _text(head)
            if _REF_TITLE.match(section):
                break
        for child in div:
            tag = child.tag.split("}")[-1]
            if tag == "p":
                t = _text(child)
            elif tag == "formula":  # 公式单独成段，便于检索到
                t = _text(child)
            else:
                continue
            if len(t) < (2 if tag == "formula" else 30):
                continue
            page = _page_of(child) or last_page
            last_page = page
            out.append((t, section, page))
    return out


def parse_grobid(path: str | Path, url: str, timeout: float = 180) -> list[Para]:
    with open(path, "rb") as f:
        r = httpx.post(
            url.rstrip("/") + "/api/processFulltextDocument",
            files={"input": (Path(path).name, f, "application/pdf")},
            data=[("segmentSentences", "1"), ("teiCoordinates", "s"), ("teiCoordinates", "head"), ("teiCoordinates", "formula"),
                  ("consolidateHeader", "0"), ("consolidateCitations", "0")],
            timeout=timeout,
        )
    if r.status_code != 200:
        raise RuntimeError(f"GROBID 返回 {r.status_code}：{r.text[:200]}")
    return parse_tei(r.text)


# ---------------------------------------------------------------------------
# MinerU
# ---------------------------------------------------------------------------
def _strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def parse_content_list(items: list[dict]) -> list[Para]:
    """MinerU content_list：[{type, text, text_level, page_idx, ...}]"""
    out: list[Para] = []
    section: str | None = None
    for it in items:
        kind = it.get("type")
        page = int(it.get("page_idx") or 0) + 1
        text = (it.get("text") or "").strip()
        if kind == "text" and it.get("text_level"):
            if _REF_TITLE.match(text):
                break
            section = text[:90]
            continue
        if kind == "text" and len(text) > 30:
            out.append((re.sub(r"\s+", " ", text), section, page))
        elif kind == "equation" and text:
            out.append((text, section, page))
        elif kind == "table":
            cap = " ".join(it.get("table_caption") or [])
            body = _strip_html(it.get("table_body") or "")
            t = f"{cap} {body}".strip()
            if len(t) > 8:
                out.append((t[:1500], section, page))
    return out


def parse_markdown(md: str, pages: list[str] | None = None) -> list[Para]:
    """MinerU 4.x 只返回 Markdown 时：按标题切段；有逐页文本时按开头文字找页码"""
    out: list[Para] = []
    section: str | None = None
    norm = lambda s: re.sub(r"\s+", "", s)  # noqa: E731
    flat = [norm(p) for p in pages or []]
    for block in re.split(r"\n\s*\n", md):
        b = block.strip()
        if not b or b.startswith("!["):
            continue
        m = re.match(r"^#{1,6}\s+(.*)$", b)
        if m:
            title = m.group(1).strip()
            if _REF_TITLE.match(title):
                break
            section = title[:90]
            continue
        t = re.sub(r"\s+", " ", _strip_html(b) if b.startswith("<") else b)
        if len(t) < 30 and not t.startswith("$$"):
            continue
        key = norm(t)[:24]
        page = next((i + 1 for i, p in enumerate(flat) if key and key in p), None)
        out.append((t, section, page or (out[-1][2] if out else 1)))
    return out


def _middle_pages(middle) -> list[str]:
    """从 middle_json（{"pdf_info": [{"page_idx", ...}]}）里收集每页的文字，结构变化时尽量不出错"""
    if isinstance(middle, str):
        try:
            middle = json.loads(middle)
        except ValueError:
            return []
    info = (middle or {}).get("pdf_info") if isinstance(middle, dict) else None
    if not isinstance(info, list):
        return []

    def collect(x) -> str:
        if isinstance(x, dict):
            return " ".join([str(x["content"]) if isinstance(x.get("content"), str) else ""] + [collect(v) for k, v in x.items() if k != "content"])
        if isinstance(x, list):
            return " ".join(collect(v) for v in x)
        return ""

    return [collect(p) for p in info]


def parse_mineru(path: str | Path, url: str, backend: str = "pipeline", timeout: float = 600) -> list[Para]:
    base = url.rstrip("/")
    name = Path(path).name
    data = Path(path).read_bytes()
    # 2.x：表单参数，content_list 带页码和标题层级
    r = httpx.post(
        base + "/file_parse",
        files=[("files", (name, data, "application/pdf"))],
        data={"backend": backend, "parse_method": "auto", "lang_list": "ch", "return_md": "false",
              "return_content_list": "true", "formula_enable": "true", "table_enable": "true"},
        timeout=timeout,
    )
    if r.status_code == 200:
        results = r.json().get("results") or {}
        res = next(iter(results.values()), {}) if results else {}
        cl = res.get("content_list")
        if isinstance(cl, str):
            cl = json.loads(cl)
        if not cl:
            raise RuntimeError("MinerU 没有返回解析结果")
        return parse_content_list(cl)
    if r.status_code not in (404, 405):
        raise RuntimeError(f"MinerU 返回 {r.status_code}：{r.text[:200]}")
    # 4.x：参数在查询串里，结果在 files[0].content
    r = httpx.post(
        base + "/v1/file_parse",
        params=[("output_formats", "markdown"), ("output_formats", "middle_json"), ("wait_timeout", str(int(timeout)))],
        files=[("files", (name, data, "application/pdf"))],
        timeout=timeout + 30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"MinerU 返回 {r.status_code}：{r.text[:200]}")
    files = r.json().get("files") or []
    content = (files[0].get("content") if files else None) or {}
    md = content.get("markdown")
    if not md:
        raise RuntimeError("MinerU 没有返回 Markdown")
    return parse_markdown(md, _middle_pages(content.get("middle_json")))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def parse_pdf(path: str | Path) -> tuple[list[Para], str, str | None]:
    """返回 (段落, 实际使用的解析器, 回退原因)。外部解析器失败时回退到 PyMuPDF。"""
    from .ingest import extract_pdf_pages, split_paragraphs

    s = get_settings()
    note = None
    if s.pdf_parser == "grobid" and s.grobid_url:
        try:
            paras = parse_grobid(path, s.grobid_url)
            if paras:
                return paras, "grobid", None
            note = "GROBID 没有解析出正文"
        except Exception as e:  # noqa: BLE001
            note = f"GROBID 不可用（{type(e).__name__}: {str(e)[:120]}）"
    elif s.pdf_parser == "mineru" and s.mineru_url:
        try:
            paras = parse_mineru(path, s.mineru_url, s.mineru_backend)
            if paras:
                return paras, "mineru", None
            note = "MinerU 没有解析出正文"
        except Exception as e:  # noqa: BLE001
            note = f"MinerU 不可用（{type(e).__name__}: {str(e)[:120]}）"
    if note:
        log.warning("PDF 解析回退到 PyMuPDF：%s", note)
    return split_paragraphs(extract_pdf_pages(path)), "pymupdf", note


def test_parser(name: str, url: str) -> dict:
    """设置页的「测试」：检查服务是否在线"""
    import time

    base = (url or "").rstrip("/")
    if not base:
        return {"ok": False, "error": "请先填写服务地址"}
    t0 = time.perf_counter()
    try:
        if name == "grobid":
            r = httpx.get(base + "/api/isalive", timeout=10)
            ok = r.status_code == 200 and "true" in r.text.lower()
            ver = httpx.get(base + "/api/version", timeout=10).text.strip() if ok else ""
            return {"ok": ok, "latency_ms": int((time.perf_counter() - t0) * 1000), "version": ver[:40] or None,
                    "error": None if ok else f"返回 {r.status_code}"}
        # MinerU：4.x 有 /v1/health，2.x 只有 /docs
        for path in ("/v1/health", "/docs"):
            r = httpx.get(base + path, timeout=10)
            if r.status_code == 200:
                return {"ok": True, "latency_ms": int((time.perf_counter() - t0) * 1000), "version": "4.x" if path == "/v1/health" else "2.x"}
        return {"ok": False, "error": f"返回 {r.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"连接失败：{type(e).__name__}"}
