"""Word 导出：编辑器生成的 Markdown（pandoc 引用语法 [@key]、[@key, p. 3]）+ 文献库生成的 BibTeX，
用 pandoc + citeproc 转成 .docx，参考文献按 CSL 格式排版（GB/T 7714—2015 / APA）。

- pandoc 来自 pypandoc-binary（随 Python 依赖一起安装，不用另装），找不到时再用系统里的 pandoc，或 PANDOC_PATH 指定；
- 版式来自 assets/reference-zh.docx：正文宋体 / Times New Roman 小四、1.5 倍行距、首行缩进 2 字符，标题黑体。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .library import bibtex_for

ASSETS = Path(__file__).resolve().parent / "assets"
CSL = {
    "gbt-numeric": "china-national-standard-gb-t-7714-2015-numeric.csl",
    "gbt-author-date": "china-national-standard-gb-t-7714-2015-author-date.csl",
    "apa": "apa.csl",
}


class PandocMissing(RuntimeError):
    pass


def pandoc_path() -> str:
    if os.getenv("PANDOC_PATH"):
        return os.environ["PANDOC_PATH"]
    try:
        import pypandoc  # type: ignore

        p = pypandoc.get_pandoc_path()
        if p:
            return p
    except Exception:  # noqa: BLE001
        pass
    p = shutil.which("pandoc")
    if p:
        return p
    raise PandocMissing("没有找到 pandoc：请重新安装后端依赖（包含 pypandoc-binary），或安装 pandoc 后设置 PANDOC_PATH")


def to_docx(markdown: str, paper_ids: list[str], style: str = "gbt-numeric", refs_title: str = "参考文献") -> bytes:
    exe = pandoc_path()
    csl = ASSETS / "csl" / CSL.get(style, CSL["gbt-numeric"])
    with tempfile.TemporaryDirectory(prefix="aria-docx-") as tmp:
        d = Path(tmp)
        body = markdown.rstrip()
        args = [exe, "in.md", "-f", "markdown", "-t", "docx", "-o", "out.docx", "--reference-doc", str(ASSETS / "reference-zh.docx")]
        if paper_ids:
            (d / "refs.bib").write_text(bibtex_for(paper_ids), encoding="utf-8")
            # 参考文献放在文末，带标题
            body += f"\n\n# {refs_title}\n\n::: {{#refs}}\n:::\n"
            args += ["--citeproc", "--bibliography", "refs.bib", "--csl", str(csl), "-M", "link-citations=true"]
        (d / "in.md").write_text(body + "\n", encoding="utf-8")
        args += ["-M", "lang=zh-CN"]
        r = subprocess.run(args, cwd=d, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"pandoc 转换失败：{(r.stderr or r.stdout).strip()[:500]}")
        return (d / "out.docx").read_bytes()
