"""后端测试：全部在 LLM_FAKE=1 下离线运行，不需要任何 API key。

    cd backend && uv run pytest -q
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_tmp = tempfile.mkdtemp(prefix="aria-test-")
os.environ["LLM_FAKE"] = "1"
os.environ["ARIA_DATA_DIR"] = _tmp
os.environ["EMBEDDING_PROVIDER"] = "none"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.ingest import Chunk, chunk_paragraphs, chunk_plain_text  # noqa: E402
from app.library import make_bibkey  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def sse(resp) -> list[dict]:
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


# ---------------------------------------------------------------- 切块
def test_chunking_terminates_and_covers_text():
    text = "\n\n".join(f"Paragraph {i}. " + "word " * 120 for i in range(30))
    chunks = chunk_plain_text(text, max_chars=1000, overlap_chars=150)
    assert 5 < len(chunks) < 60
    assert "Paragraph 29" in chunks[-1].text
    assert all(len(c.text) <= 1400 for c in chunks)


def test_chunking_short_text_and_section_tail():
    assert len(chunk_plain_text("short text that is long enough to keep around", 800, 100)) == 1
    paras = [("A" * 900, "1 Intro", 1), ("B" * 900, "1 Intro", 1), ("tiny tail paragraph", "2 Method", 2)]
    chunks = chunk_paragraphs(paras, max_chars=1000, overlap_chars=200)
    assert chunks[-1].section == "2 Method" and "tiny tail" in chunks[-1].text


def test_huge_paragraph_without_punctuation():
    chunks = chunk_paragraphs([("x" * 5000, None, 1)], max_chars=1000, overlap_chars=100)
    assert len(chunks) >= 5 and all(isinstance(c, Chunk) for c in chunks)


def test_bibkey():
    assert make_bibkey(["Ashish Vaswani"], 2017, "Attention Is All You Need") == "vaswani2017attention"
    assert make_bibkey(["Müller, Hans"], 2020, "On the Theory") == "muller2020theory"


# ---------------------------------------------------------------- 文献库
def test_papers_flow():
    r = client.get("/api/papers/external", params={"q": "retrieval augmented generation"})
    results = r.json()["results"]
    assert results and results[0]["title"]
    rag = next(p for p in results if "Retrieval-Augmented" in p["title"])
    r1 = client.post("/api/papers", json=rag).json()
    assert r1["created"] and r1["paper"]["bibkey"] == "lewis2020retrieval"
    r2 = client.post("/api/papers", json=rag).json()
    assert not r2["created"], "重复添加应去重"
    bib = client.get("/api/papers/bibtex").text
    assert "@" in bib and "lewis2020retrieval" in bib


def test_upload_pdf_and_retrieve():
    import fitz

    pdf = Path(_tmp) / "sample.pdf"
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    lines = ["Graph Neural Citation Checking", "", "1 Introduction"]
    lines += ["Citation hallucination is a major failure mode of large language models in scientific writing."] * 3
    lines += ["", "2 Method", "We verify each claim against retrieved evidence passages from the cited paper."] * 2
    lines += ["", "References", "[1] Some reference that should not be indexed."]
    for line in lines:
        page.insert_text((72, y), line, fontsize=10 if y > 80 else 16)
        y += 14
    doc.save(str(pdf))
    with open(pdf, "rb") as f:
        r = client.post("/api/papers/upload", files={"file": ("sample.pdf", f, "application/pdf")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["chunks"] >= 1 and body["paper"]["has_fulltext"]
    pid = body["paper"]["id"]
    chunks = client.get(f"/api/papers/{pid}/chunks").json()
    assert not any("should not be indexed" in c["text"] for c in chunks)

    cands = client.post("/api/assist/cite", json={"sentence": "LLMs often hallucinate citations in scientific writing"}).json()
    assert cands["candidates"][0]["paper"]["id"] == pid
    assert cands["candidates"][0]["verdict"] in {"supports", "partial"}
    ver = client.post("/api/assist/verify", json={"sentence": "Citation hallucination is common", "paper_ids": [pid, "nope"]}).json()
    assert ver["results"][1]["verdict"] == "missing"


# ---------------------------------------------------------------- 编辑辅助
def test_complete_and_edit_and_ask():
    t = client.post("/api/assist/complete", json={"before": "近年来，大语言模型在学术写作中的应用越来越多。"}).json()["text"]
    assert t and not t.startswith("近年来")
    events = sse(client.post("/api/assist/edit", json={"text": "这个方法非常好。", "action": "polish"}))
    assert events[-1]["type"] == "done"
    assert "".join(e["text"] for e in events if e["type"] == "token")
    events = sse(client.post("/api/assist/ask", json={"question": "retrieval augmented generation 是什么"}))
    assert events[0]["type"] == "sources" and events[-1]["type"] == "done"


def test_documents_crud():
    d = client.post("/api/documents", json={"title": "测试论文"}).json()
    content = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}]}
    assert client.put(f"/api/documents/{d['id']}", json={"content": content}).json()["ok"]
    assert client.get(f"/api/documents/{d['id']}").json()["content"] == content
    assert any(x["id"] == d["id"] for x in client.get("/api/documents").json())


# ---------------------------------------------------------------- LangGraph 工作流
def test_agent_interrupt_resume_regenerate():
    events = sse(client.post("/api/agent/start", json={"topic": "检索增强的论文写作智能体", "max_papers": 3}))
    tid = events[0]["thread_id"]
    intr = next(e for e in events if e["type"] == "interrupt")["value"]
    assert intr["kind"] == "select_papers" and intr["candidates"]
    assert events[-1] == {"type": "status", "status": "waiting"}

    # 状态可以随时从 checkpointer 读回（模拟刷新页面）
    st = client.get(f"/api/agent/{tid}").json()
    assert st["status"] == "waiting" and st["interrupt"]["kind"] == "select_papers"

    chosen = [c["cid"] for c in intr["candidates"][:3]]
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"selected": chosen}}))
    intr = next(e for e in events if e["type"] == "interrupt")["value"]
    assert intr["kind"] == "review_outline" and len(intr["outline"]) >= 3

    # 要求重写大纲 → 回到 make_outline 再次 interrupt
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "regenerate", "feedback": "更突出实验"}}))
    intr = next(e for e in events if e["type"] == "interrupt")["value"]
    assert intr["kind"] == "review_outline"

    outline = intr["outline"][:2]
    outline[0]["title"] = "绪论（用户修改）"
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "approve", "outline": outline}}))
    done = events[-1]
    assert done["type"] == "done"
    assert done["result"]["outline"][0]["title"] == "绪论（用户修改）"
    known = {p["bibkey"] for p in client.get("/api/papers").json()}
    for sec in done["result"]["outline"]:
        assert set(sec["bibkeys"]) <= known, "大纲中的引用必须来自文献库"

    r = client.post(f"/api/agent/{tid}/resume", json={"value": {}})
    assert r.status_code == 409


def test_agent_select_none_ends():
    events = sse(client.post("/api/agent/start", json={"topic": "anything at all"}))
    tid = events[0]["thread_id"]
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"selected": []}}))
    assert events[-1]["type"] == "done"


@pytest.fixture(autouse=True, scope="session")
def _cleanup():
    yield


# ---------------------------------------------------------------- LiteLLM 接入层
def test_resolve_model_and_tiers(monkeypatch):
    from app import llm

    assert llm.resolve_model("deepseek/deepseek-chat") == "deepseek/deepseek-chat"
    assert llm.resolve_model("ollama_chat/qwen2.5:7b") == "ollama_chat/qwen2.5:7b"
    assert llm.resolve_model("mimo-v2.5-pro") == "openai/mimo-v2.5-pro"  # 旧配置：无前缀 → OpenAI 兼容
    assert llm.resolve_model("Qwen/Qwen2.5-7B-Instruct") == "openai/Qwen/Qwen2.5-7B-Instruct"
    h = client.get("/api/health").json()
    assert set(h["tiers"]) == {"complete", "write", "judge", "agent"}


def test_real_path_with_mocked_litellm(monkeypatch):
    """不走 FAKE：mock 掉 litellm.completion，验证分档、JSON 模式降级、备用模型和调用日志。"""
    import dataclasses
    from types import SimpleNamespace

    from app import config, llm

    base = config.get_settings()
    tiers = dict(base.tiers)
    tiers["agent"] = dataclasses.replace(tiers["agent"], model="openai/bad-model", fallbacks=("deepseek/deepseek-chat",), api_key="k")
    tiers["judge"] = dataclasses.replace(tiers["judge"], api_key="k")
    fake_settings = dataclasses.replace(base, llm_fake=False, tiers=tiers)
    monkeypatch.setattr(llm, "get_settings", lambda: fake_settings)

    calls = []

    def completion(**kw):
        calls.append(kw)
        if kw["model"] == "openai/bad-model":
            raise RuntimeError("boom")
        if "response_format" in kw:
            raise llm.litellm.BadRequestError("json mode unsupported", model=kw["model"], llm_provider="deepseek")
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": 1}'))], usage=usage)

    monkeypatch.setattr(llm.litellm, "completion", completion)
    assert llm.chat_json([{"role": "user", "content": "hi"}], tier="agent") == {"ok": 1}
    assert [c["model"] for c in calls] == ["openai/bad-model", "deepseek/deepseek-chat", "deepseek/deepseek-chat"]
    assert calls[0]["timeout"] == tiers["agent"].timeout
    st = client.get("/api/llm/stats").json()["tiers"]["agent"]
    assert st["calls"] >= 2 and st["errors"] >= 1 and st["prompt_tokens"] >= 10
