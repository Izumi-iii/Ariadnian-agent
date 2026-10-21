"""文献问答的示例问题：根据当前论文（题目、章节）和文献库（论文、你的笔记）生成，并逐个试检索，
优先保留文献库里确实找得到依据的问题，并附上能回答它的文献。

流程：模型出 6–8 个候选 → 每个候选都在文献库里检索一次 → 按「能覆盖几篇文献、检索得分」排序 → 取前 k 个。
同样的输入（题目、章节、文献库、笔记数）结果缓存在内存里，切换页签不会重复调用模型。
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict

from . import llm
from .assist import is_chinese, retrieval_query
from .db import get_conn
from .library import get_paper, list_papers
from .retrieval import search

_CACHE: OrderedDict[str, list[dict]] = OrderedDict()
_CACHE_MAX = 32


def _short(title: str, n: int = 24) -> str:
    """论文标题太长时取冒号前的简称（如 "Self-RAG: Learning to ..." → "Self-RAG"）"""
    head = re.split(r"[:：]", title)[0].strip()
    return head if 2 <= len(head) <= n else title[:n] + ("…" if len(title) > n else "")


def _notes(limit: int = 6) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT paper_id, quote, comment FROM notes ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def _fake(papers: list, title: str, zh: bool) -> str:
    def name(p) -> str:  # 冒号前有简称就用简称（Self-RAG），否则用「第一作者 等（年份）」
        head = re.split(r"[:：]", p.title)[0].strip()
        if head != p.title.strip() and len(head) <= 24:
            return head
        last = (p.authors[0].split()[-1] if p.authors else "") or _short(p.title)
        return f"{last} 等（{p.year}）" if p.year else last

    a = name(papers[0])
    b = name(papers[1]) if len(papers) > 1 else None
    qs = [
        f"{a} 的核心方法是什么？",
        f"{a} 和 {b} 的思路有什么不同？" if b else f"{a} 有哪些局限？",
        "这些论文是怎么评测效果的？",
        "检索增强生成如何减少事实错误？",
        f"围绕“{title[:16]}”，现有方法还有哪些不足？" if title else "现有方法还有哪些不足？",
        "哪些工作讨论了引用是否可信？",
    ]
    if not zh:
        qs = [f"What is the core idea of {a}?", "How do these papers evaluate their methods?", "What limitations remain?"]
    return json.dumps({"questions": qs}, ensure_ascii=False)


def suggest_questions(title: str = "", headings: list[str] | None = None, k: int = 4, refresh: bool = False) -> list[dict]:
    papers = list_papers()
    if not papers:
        return []
    headings = [h for h in (headings or []) if h.strip()][:12]
    notes = _notes()
    zh = is_chinese(title + "".join(headings)) or not (title or headings)
    key = hashlib.sha1(json.dumps([title, headings, sorted(p.id for p in papers), len(notes), k]).encode()).hexdigest()
    if not refresh and key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]

    lib = "\n".join(
        f"- {p.title}（{p.year or 'n.d.'}）" + (f"：{(p.abstract or '')[:220]}" if p.abstract else "")
        for p in papers[:14]
    )
    note_txt = "\n".join(f"- “{n['quote'][:120]}”" + (f"（{n['comment'][:60]}）" if n["comment"] else "") for n in notes)
    user = (
        f"我在写的论文：{title or '（未命名）'}\n"
        + (f"章节：{'；'.join(headings)}\n" if headings else "")
        + f"\n我的文献库：\n{lib}\n"
        + (f"\n我在原文上记的笔记：\n{note_txt}\n" if note_txt else "")
        + "\n请提出 8 个我可能想问文献库的问题，要求："
        "1) 能用上面这些文献回答，最好涉及具体的论文或方法名；"
        "2) 与我的论文题目和章节相关，帮我写作；"
        "3) 类型多样：核心思路、方法对比、评测方式、局限与不足、研究现状；"
        f"4) 每个不超过 30 个字，用{'中文' if zh else 'English'}。"
        '只输出 JSON：{"questions": ["问题1", "问题2"]}'
    )
    try:
        data = llm.chat_json(
            [{"role": "system", "content": "你是帮研究生快速读懂文献的助手。"}, {"role": "user", "content": user}],
            tier="judge", fake=_fake(papers, title, zh), max_tokens=800, temperature=0.7 if refresh else 0.3,
        ) or {}
    except Exception:  # noqa: BLE001 —— 示例问题生成失败不影响使用，前端保留默认示例
        return []
    cands = []
    for q in data.get("questions") or []:
        q = str(q).strip().strip("0123456789.、）) ")
        if 4 <= len(q) <= 60 and q not in cands:
            cands.append(q)

    # 逐个试检索：文献库里找不到依据的问题不要
    scored = []
    for q in cands:
        hits = search(retrieval_query(q), top_k=6)
        if not hits:
            continue
        seen: list[str] = []
        for h in hits:
            if h.paper_id not in seen:
                seen.append(h.paper_id)
        papers_used = [p for p in (get_paper(pid) for pid in seen[:3]) if p]
        scored.append({
            "q": q,
            "papers": [{"id": p.id, "bibkey": p.bibkey, "short": _short(p.title, 18), "year": p.year} for p in papers_used],
            "score": round(float(hits[0].score), 3),
        })
    # 覆盖的文献越多越好（更适合综述式提问），其次看检索得分；同时尽量别让前几个问题都指向同一篇
    scored.sort(key=lambda x: (-len(x["papers"]), -x["score"]))
    out, used_first = [], set()
    for s in scored:
        lead = s["papers"][0]["id"] if s["papers"] else ""
        if lead in used_first and len(out) < k - 1 and len(scored) > k:
            continue
        out.append(s)
        used_first.add(lead)
        if len(out) >= k:
            break
    for s in scored:  # 去重规则太严导致不够 k 个时补齐
        if len(out) >= k:
            break
        if s not in out:
            out.append(s)
    # 文献库很小时关键词检索可能一条都命中不了：用模型给的候选补齐（它们本来就是照着文献库出的），只是不标来源
    for q in cands:
        if len(out) >= k:
            break
        if all(o["q"] != q for o in out):
            out.append({"q": q, "papers": [], "score": 0.0})

    _CACHE[key] = out
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)
    return out
