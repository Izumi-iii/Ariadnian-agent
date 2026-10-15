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


# ---------------------------------------------------------------- 页边批注
def test_reasoning_model_empty_output_is_retried(monkeypatch):
    """推理模型把 max_tokens 全用在思考上、正文为空时，放宽上限重试一次。"""
    import dataclasses
    from types import SimpleNamespace

    from app import config, llm

    base = config.get_settings()
    tiers = dict(base.tiers)
    tiers["judge"] = dataclasses.replace(tiers["judge"], api_key="k", fallbacks=())
    monkeypatch.setattr(llm, "get_settings", lambda: dataclasses.replace(base, llm_fake=False, tiers=tiers))
    seen = []

    def completion(**kw):
        seen.append(kw["max_tokens"])
        text, finish = ("", "length") if kw["max_tokens"] else ("retrieval augmented generation", "stop")
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text), finish_reason=finish)], usage=None)

    monkeypatch.setattr(llm.litellm, "completion", completion)
    assert llm.chat([{"role": "user", "content": "hi"}], tier="judge", max_tokens=80) == "retrieval augmented generation"
    assert seen == [80, None]


def test_split_sentences_keeps_trailing_cites():
    from app.assist import split_sentences

    s = split_sentences("第一句结论。[@a; @b]第二句话[@c]。Third one. Fourth.")
    assert s[0].endswith("[@a; @b]") and "[@c]" in s[1] and len(s) == 4


def test_annotate_paragraph():
    r = client.get("/api/papers/external", params={"q": "retrieval augmented generation"}).json()["results"]
    for p in r[:3]:
        client.post("/api/papers", json=p)
    key = next(p["bibkey"] for p in client.get("/api/papers").json() if p["title"].startswith("Retrieval-Augmented"))
    para = (f"检索增强生成通过引入外部知识降低了事实错误[@{key}]。"
            "现有方法在很大程度上难以保证引用的可验证性。"
            "大语言模型在生成长文本时经常出现事实性错误和虚构的参考文献。")
    anns = client.post("/api/assist/annotate", json={"paragraph": para}).json()["annotations"]
    kinds = {a["kind"]: a for a in anns}
    assert set(kinds) == {"cite_check", "missing_citation", "rewrite"}
    assert kinds["cite_check"]["anchor"] == "检索增强生成通过引入外部知识降低了事实错误。"
    assert kinds["cite_check"]["items"][0]["bibkey"] == key
    plain = para.replace(f"[@{key}]", "")
    for a in anns:
        assert a["anchor"] in plain, "anchor 必须能在去掉引用后的正文里原样找到"
    assert "很大程度上" not in kinds["rewrite"]["revised"]
    # 不存在的 bibkey
    anns = client.post("/api/assist/annotate", json={"paragraph": "这是一句话[@nope2099x]。", "review": False}).json()["annotations"]
    assert anns[0]["items"][0]["verdict"] == "missing"


# ---------------------------------------------------------------- 学术检索：限流重试 / 补位 / 缓存
def _scholar_env(monkeypatch, handler):
    import dataclasses

    import httpx

    from app import config, scholar

    real = config.get_settings()
    fake = dataclasses.replace(real, llm_fake=False, semantic_scholar_api_key=None, search_cache_days=7)
    monkeypatch.setattr(scholar, "get_settings", lambda: fake)
    monkeypatch.setattr(scholar, "_TRANSPORT", httpx.MockTransport(handler))
    sleeps: list[float] = []
    monkeypatch.setattr(scholar, "_sleep", sleeps.append)
    scholar._cooldown_until.clear()
    for t in scholar._THROTTLES.values():
        t.next_at = 0.0
    with __import__("app.db", fromlist=["get_conn"]).get_conn() as conn:
        conn.execute("DELETE FROM search_cache")
    return scholar, sleeps


S2_OK = {"data": [{"title": "GUI Agents Survey", "authors": [{"name": "Ada Lovelace"}], "year": 2025, "venue": "ACL",
                   "externalIds": {"DOI": "10.1/gui"}, "url": "https://s2/x", "abstract": "about GUI agents", "citationCount": 3}]}
OA_OK = {"results": [{"display_name": "Screen Understanding with VLMs", "publication_year": 2024, "doi": "https://doi.org/10.48550/arxiv.2401.00001",
                      "authorships": [{"author": {"display_name": "Grace Hopper"}}], "cited_by_count": 7,
                      "primary_location": {"source": {"display_name": "arXiv"}, "landing_page_url": "https://arxiv.org/abs/2401.00001"},
                      "abstract_inverted_index": {"Screens": [0], "are": [1], "hard": [2]}}]}


def test_scholar_429_falls_back_to_openalex_and_cools_down(monkeypatch):
    import httpx

    hits = {"s2": 0, "oa": 0}

    def handler(req: httpx.Request):
        if "semanticscholar" in req.url.host:
            hits["s2"] += 1
            return httpx.Response(429)
        hits["oa"] += 1
        return httpx.Response(200, json=OA_OK)

    scholar, sleeps = _scholar_env(monkeypatch, handler)
    res, notes = scholar.search("gui agent", ["semantic_scholar"])
    assert hits["s2"] == 4 and hits["oa"] == 1  # 1 次请求 + 3 次重试，然后 OpenAlex 补位
    assert res[0].title == "Screen Understanding with VLMs"
    assert res[0].arxiv_id == "2401.00001" and res[0].doi is None
    assert res[0].abstract == "Screens are hard"
    assert any("429" in n and "OpenAlex" in n for n in notes)
    assert any("SEMANTIC_SCHOLAR_API_KEY" in n for n in notes)
    assert [s for s in sleeps if float(s).is_integer()][:3] == [1.0, 2.0, 4.0]  # 指数退避（限速等待不是整数秒）

    # 冷却期内换一个检索式：不再请求 S2，直接走 OpenAlex
    res, notes = scholar.search("vision language model gui", ["semantic_scholar"])
    assert hits["s2"] == 4 and hits["oa"] == 2
    assert any("暂停使用" in n for n in notes)


def test_scholar_retry_after_then_success_and_cache(monkeypatch):
    import httpx

    calls = {"n": 0}

    def handler(req: httpx.Request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "2"})
        return httpx.Response(200, json=S2_OK)

    scholar, sleeps = _scholar_env(monkeypatch, handler)
    res, notes = scholar.search("GUI   agent", ["semantic_scholar"])
    assert res[0].title == "GUI Agents Survey" and not notes
    assert 2.0 in sleeps  # 遵守 Retry-After
    res2, _ = scholar.search("gui agent", ["semantic_scholar"])  # 大小写/空格不同也命中缓存
    assert calls["n"] == 2 and res2[0].title == "GUI Agents Survey"


# ---------------------------------------------------------------- 网页设置
@pytest.fixture
def clean_settings():
    from app import config

    yield
    keys = list(config.load_overrides())
    if keys:
        config.save_overrides({k: None for k in keys})


def test_settings_roundtrip_and_secret_masking(clean_settings):
    from app import config

    v = client.get("/api/settings").json()["values"]
    assert "value" not in v["LLM_API_KEY"] and "MODEL_ID" in v

    r = client.put("/api/settings", json={"values": {
        "MODEL_ID": "openai/qwen-plus",
        "LLM_API_BASE": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "LLM_API_KEY": "sk-test-1234567890abcd",
        "MODEL_COMPLETE": "ollama_chat/qwen2.5:7b",
        "SEARCH_SOURCES": "arxiv, openalex",
    }}).json()
    assert r["values"]["LLM_API_KEY"]["hint"] == "····abcd" and r["values"]["LLM_API_KEY"]["source"] == "ui"
    assert "sk-test" not in str(r), "密钥不能出现在返回值里"
    assert r["tiers"]["write"]["model"] == "openai/qwen-plus"
    assert r["tiers"]["complete"]["model"] == "ollama_chat/qwen2.5:7b"
    # 立即生效，不用重启
    assert client.get("/api/health").json()["model"] == "openai/qwen-plus"
    assert config.get_settings().search_sources == ["arxiv", "openalex"]
    assert config.get_settings().tiers["judge"].api_key == "sk-test-1234567890abcd"
    assert "qwen-plus" in config.settings_path().read_text(encoding="utf-8")

    # 清空 → 回到 .env / 默认值
    r = client.put("/api/settings", json={"values": {"MODEL_ID": "", "MODEL_COMPLETE": None}}).json()
    assert r["values"]["MODEL_ID"]["source"] != "ui"
    assert r["tiers"]["write"]["model"] == "deepseek/deepseek-chat"


def test_settings_validation(clean_settings):
    assert client.put("/api/settings", json={"values": {"EVIL": "1"}}).status_code == 400
    assert client.put("/api/settings", json={"values": {"SEARCH_SOURCES": "google"}}).status_code == 400
    assert client.put("/api/settings", json={"values": {"MODEL_WRITE_TIMEOUT": "abc"}}).status_code == 400


def test_settings_test_llm(monkeypatch, clean_settings):
    from types import SimpleNamespace

    from app import llm

    # 离线模式：不真正调用
    assert client.post("/api/settings/test-llm", json={"tier": "write"}).json()["fake"] is True

    # 关闭离线模式，mock LiteLLM
    client.put("/api/settings", json={"values": {"LLM_FAKE": "0"}})
    seen = {}

    def ok(**kw):
        seen.update(kw)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="OK"))])

    monkeypatch.setattr(llm.litellm, "completion", ok)
    r = client.post("/api/settings/test-llm", json={"model": "qwen-plus", "api_base": "https://x/v1", "api_key": "sk-unsaved-9999"}).json()
    assert r["ok"] and r["model"] == "openai/qwen-plus" and r["reply"] == "OK"
    assert seen["api_key"] == "sk-unsaved-9999" and seen["api_base"] == "https://x/v1"

    def bad(**kw):
        raise RuntimeError(f"AuthenticationError: invalid key {kw['api_key']}")

    monkeypatch.setattr(llm.litellm, "completion", bad)
    r = client.post("/api/settings/test-llm", json={"model": "qwen-plus", "api_key": "sk-secret-0000"}).json()
    assert not r["ok"] and "sk-secret" not in r["error"] and "****" in r["error"]
    assert "API Key" in r["hint"]


def test_settings_explicit_empty_overrides_env(monkeypatch, clean_settings):
    from app import config

    monkeypatch.setenv("LLM_API_BASE", "https://old-gateway.example/v1")
    config.get_settings.cache_clear()
    assert config.get_settings().tiers["write"].api_base == "https://old-gateway.example/v1"
    v = client.put("/api/settings", json={"values": {"LLM_API_BASE": "__none__", "MODEL_ID": "deepseek/deepseek-chat"}}).json()
    assert config.get_settings().tiers["write"].api_base is None  # 不再回退到 .env 的旧地址
    assert v["values"]["LLM_API_BASE"]["source"] == "ui" and v["values"]["LLM_API_BASE"]["value"] is None
    monkeypatch.delenv("LLM_API_BASE")
    config.get_settings.cache_clear()


def test_pricing_and_usage_stats(clean_settings):
    """价格表：DeepSeek 高峰翻倍、缓存命中按缓存价；自定义价格优先；统计接口给出按天和按模型的费用。"""
    from app import pricing
    from app.db import get_conn

    p = pricing.price_for("openai/deepseek-flash")
    row = {"prompt_tokens": 1_000_000, "cached_tokens": 500_000, "completion_tokens": 100_000}
    assert abs(pricing.call_cost({**row, "ts": "2026-10-17 02:30:00"}, p) - 0.91) < 1e-9  # 周六，空闲
    assert abs(pricing.call_cost({**row, "ts": "2026-10-15 02:30:00"}, p) - 1.82) < 1e-9  # 周四 10:30，高峰
    assert pricing.price_for("openai/some-unknown-model") is None
    assert pricing.price_for("ollama_chat/qwen2.5:7b").input == 0

    bad = client.put("/api/settings", json={"values": {"MODEL_PRICES": "not json"}})
    assert bad.status_code == 400
    ok = client.put("/api/settings", json={"values": {"MODEL_PRICES": '{"openai/my-model": {"input": 2, "output": 8}}'}})
    assert ok.status_code == 200
    assert pricing.price_for("my-model").output == 8

    with get_conn() as conn:
        conn.execute("DELETE FROM llm_calls")
        conn.execute("INSERT INTO llm_calls (tier, model, ok, latency_ms, prompt_tokens, completion_tokens, cached_tokens) "
                     "VALUES ('judge', 'openai/my-model', 1, 800, 1000000, 500000, 0)")
        conn.execute("INSERT INTO llm_calls (tier, model, ok, latency_ms, prompt_tokens, completion_tokens) "
                     "VALUES ('complete', 'openai/unknown', 1, 300, 100, 10)")
    st = client.get("/api/llm/stats?days=7").json()
    assert st["currency"] == "CNY" and len(st["daily"]) == 7
    assert st["tiers"]["judge"]["cost_cny"] == 6.0  # 1M × 2 + 0.5M × 8
    assert st["tiers"]["complete"]["cost_cny"] is None and st["tiers"]["complete"]["unpriced_calls"] == 1
    assert st["daily"][-1]["tiers"]["judge"]["cost_cny"] == 6.0
    assert {m["model"] for m in st["models"]} == {"openai/my-model", "openai/unknown"}
