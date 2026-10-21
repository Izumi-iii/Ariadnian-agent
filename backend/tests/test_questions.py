"""文献问答示例问题：来自文献库、试检索过、有缓存；文献库为空时不给。全部离线（LLM_FAKE）。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-questions-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import questions  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def test_questions_grounded_in_library(monkeypatch):
    if not client.get("/api/papers").json():
        assert client.post("/api/assist/questions", json={"title": "x"}).json()["questions"] == []
    text = (
        "Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection. Self-RAG trains a language model "
        "to retrieve on demand and critique its own generations with reflection tokens, improving factuality and citation accuracy.\n\n"
        "We evaluate citation precision and recall on long-form generation."
    )
    r = client.post("/api/papers/upload", files={"file": ("selfrag.txt", text.encode(), "text/plain")})
    pid = r.json()["paper"]["id"]
    client.patch(f"/api/papers/{pid}", json={"title": "Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection", "year": 2024})

    calls = []
    real = questions.llm.chat_json
    monkeypatch.setattr(questions.llm, "chat_json", lambda *a, **kw: calls.append(1) or real(*a, **kw))
    body = {"title": "面向学术写作的检索增强与引用核查", "headings": ["引言", "相关工作"]}
    qs = client.post("/api/assist/questions", json=body).json()["questions"]
    assert len(qs) == 4
    assert "Self-RAG" in qs[0]["q"] or any(p["short"] == "Self-RAG" for q in qs for p in q["papers"])
    # 检索到依据的问题排在前面，并标出来源文献
    flags = [bool(q["papers"]) for q in qs]
    assert flags == sorted(flags, reverse=True)
    # 同样的输入走缓存，不再调用模型；refresh 则重新生成
    client.post("/api/assist/questions", json=body)
    assert len(calls) == 1
    client.post("/api/assist/questions", json=body | {"refresh": True})
    assert len(calls) == 2
