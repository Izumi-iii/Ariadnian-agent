"""分节写作 Agent：逐节写草稿、引用只来自证据、自查与批注、逐节确认 / 连续写完。全部离线（LLM_FAKE）。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("LLM_FAKE_STREAM_DELAY", "0")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-writer-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.agent.writer import clean_citations  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

TEXT = (
    "Retrieval-augmented generation retrieves documents from an external index before generating the answer, "
    "which reduces factual errors of large language models.\n\n"
    "The retrieved document is treated as a latent variable and the generator marginalizes over documents. "
    "Dense retrieval maps questions and passages into the same vector space."
)


def sse(resp) -> list[dict]:
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


@pytest.fixture(scope="module")
def bibkey() -> str:
    r = client.post("/api/papers/upload", files={"file": ("rag-notes.txt", TEXT.encode(), "text/plain")})
    pid = r.json()["paper"]["id"]
    p = client.patch(f"/api/papers/{pid}", json={"title": "Retrieval-Augmented Generation", "bibkey": "lewis2020rag", "year": 2020}).json()
    # 一条用户笔记：写作时应当作为证据
    client.post("/api/notes", json={"paper_id": pid, "page": 3, "quote": "the generator marginalizes over documents", "comment": "核心思想"})
    return p["bibkey"]


def _outline(key: str) -> list[dict]:
    return [
        {"title": "引言", "goal": "检索增强生成如何减少大语言模型的事实错误", "bibkeys": [key]},
        {"title": "相关工作", "goal": "稠密检索与隐变量边缘化", "bibkeys": [key]},
        {"title": "结论", "goal": "总结", "bibkeys": []},
    ]


def test_clean_citations_drops_unknown_keys():
    t = "A claim [@good, p. 3]. Another [@fake2024]. Mixed [@good; @fake2024] 结尾 [@nope]。"
    out = clean_citations(t, {"good"})
    assert "[@good, p. 3]" in out and "fake2024" not in out and "nope" not in out
    assert "[@good]" in out and out.endswith("结尾。")


def test_write_confirm_mode(bibkey):
    events = sse(client.post("/api/agent/write", json={"outline": _outline(bibkey), "doc_title": "测试论文", "mode": "confirm"}))
    tid = events[0]["thread_id"]
    intr = next(e for e in events if e["type"] == "interrupt")["value"]
    assert intr["kind"] == "review_section" and intr["index"] == 0 and intr["total"] == 3
    d = intr["draft"]
    assert d["paragraphs"] and len(d["annotations"]) == len(d["paragraphs"])
    # 引用只能来自文献库里的文献
    text = " ".join(d["paragraphs"])
    # 离线规则判定中文句子与英文原文不相关 → 自查会把撑不起的引用改掉，并计入 fixed
    cited = set(__import__("re").findall(r"@([\w:.-]+)", text))
    assert cited or d["fixed"] >= 1
    known = {p["bibkey"] for p in client.get("/api/papers").json()}
    evidence_keys = {e["bibkey"] for e in d["evidence"]}
    assert cited <= known and cited <= evidence_keys
    # 证据里包含用户笔记
    assert any(e["source"] == "note" for e in d["evidence"])
    progress = [e["message"] for e in events if e["type"] == "progress"]
    assert any("自查引用" in m for m in progress) and any("证据" in m for m in progress)
    # 流式：先有 token 增量，拼起来就是初稿；之后 done 事件给出自查后的定稿
    tokens = "".join(e["delta"] for e in events if e.get("phase") == "token" and e.get("section") == 0)
    assert "引言部分围绕" in tokens
    done0 = next(e for e in events if e.get("phase") == "done" and e.get("section") == 0)
    assert done0["draft"]["paragraphs"] == d["paragraphs"]

    # 刷新页面也能恢复
    st = client.get(f"/api/agent/{tid}").json()
    assert st["kind"] == "write" and st["interrupt"]["kind"] == "review_section"
    assert st["result"]["polish_done"] is False

    # 按意见重写本节 → 仍停在第 1 节
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "regenerate", "feedback": "更简洁"}}))
    assert next(e for e in events if e["type"] == "interrupt")["value"]["index"] == 0
    # 写入并继续 → 第 2 节
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "accept"}}))
    assert next(e for e in events if e["type"] == "interrupt")["value"]["index"] == 1
    # 跳过 → 第 3 节；停止 → 结束
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "skip"}}))
    assert next(e for e in events if e["type"] == "interrupt")["value"]["index"] == 2
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "stop"}}))
    done = events[-1]
    assert done["type"] == "done" and done["result"]["kind"] == "write"
    assert [d["status"] for d in done["result"]["drafts"]] == ["accepted", "skipped", "skipped"]  # 停止时当前这节不写入

    threads = client.get("/api/agent").json()
    assert any(t["thread_id"] == tid and t["kind"] == "write" for t in threads)


def test_write_auto_mode_streams_each_section(bibkey):
    events = sse(client.post("/api/agent/write", json={"outline": _outline(bibkey)[:2], "mode": "auto", "length": "short"}))
    drafts = [e["draft"] for e in events if e["type"] == "progress" and e.get("phase") == "done"]
    assert [d["title"] for d in drafts] == ["引言", "相关工作"]
    assert not any(e["type"] == "interrupt" for e in events)
    assert events[-1]["type"] == "done"
    # 草稿留在文档里（标记为草稿），由用户最后统一保留或删除
    assert all(d["status"] == "drafted" for d in events[-1]["result"]["drafts"])


def test_write_only_selected_sections(bibkey):
    events = sse(client.post("/api/agent/write", json={"outline": _outline(bibkey), "mode": "auto", "selected": [2, 0, 9]}))
    written = [e["section"] for e in events if e.get("phase") == "done"]
    assert written == [0, 2]  # 按大纲顺序，越界的下标忽略
    result = events[-1]["result"]
    assert result["order"] == [0, 2] and result["drafts"][1]["status"] == "excluded"
    assert client.post("/api/agent/write", json={"outline": _outline(bibkey), "selected": [7]}).status_code == 422


def test_write_parallel_with_editor_pass(bibkey):
    events = sse(client.post("/api/agent/write", json={"outline": _outline(bibkey), "mode": "parallel", "polish": True}))
    assert not any(e["type"] == "interrupt" for e in events)
    # 三个子 Agent 都流式输出并各自写完
    assert {e["section"] for e in events if e.get("phase") == "token"} == {0, 1, 2}
    assert sorted(e["section"] for e in events if e.get("phase") == "done") == [0, 1, 2]
    nodes = [e["node"] for e in events if e["type"] == "node"]
    assert nodes.count("write_one") == 3 and nodes.index("collect") > max(i for i, n in enumerate(nodes) if n == "write_one")
    # 总编统稿：每处修改单独发出，修改结果反映在最终草稿里
    edits = [e for e in events if e.get("phase") == "edit"]
    assert edits and all(e["after"].startswith("承接上一节") and e["before"] != e["after"] for e in edits)
    result = events[-1]["result"]
    assert len(result["edits"]) == len(edits) and result["polish_summary"]
    assert result["polish_done"] is True
    for e in edits:
        assert result["drafts"][e["section"]]["paragraphs"][e["para"]] == e["after"]


def test_write_validates_outline():
    assert client.post("/api/agent/write", json={"outline": []}).status_code == 422
