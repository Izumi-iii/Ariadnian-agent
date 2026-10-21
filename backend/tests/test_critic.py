"""审稿 Agent：挑问题并定位到原文、作者修改 / 回复后再审、轮数上限、停止后继续。全部离线（LLM_FAKE）。"""
from __future__ import annotations

import json
import re
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-critic-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.agent.critic import locate  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

SECTIONS = [
    {"title": "1 引言", "text": (
        "大语言模型在问答任务上表现突出，但经常生成与事实不符的内容 [@lewis2020rag]。"
        "检索增强生成在回答之前先检索外部知识，因此可以彻底消除幻觉问题，并且在所有任务上都优于纯参数化模型。\n\n"
        "本文提出的方法显著提高了引用的准确率。"
    )},
    {"title": "2 方法", "text": "我们先检索，再写作，最后核查引用。"},
]


def sse(resp) -> list[dict]:
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


def test_locate_exact_and_fuzzy():
    a, sec = locate("本文提出的方法显著提高了引用的准确率。", SECTIONS)
    assert a == "本文提出的方法显著提高了引用的准确率。" and sec == "1 引言"
    # 引用标记、空白不影响定位
    a, _ = locate("但经常生成与事实不符的内容 [@lewis2020rag]。", SECTIONS)
    assert a.startswith("大语言模型") is False and "事实不符" in a
    # 模型略微改写了原句：按重合度找回原句
    a, _ = locate("本文方法显著提高了引用准确率", SECTIONS)
    assert a == "本文提出的方法显著提高了引用的准确率。"
    assert locate("完全无关的一句话，讲的是天气和足球", SECTIONS)[0] == ""


def test_critique_rounds_and_followups():
    events = sse(client.post("/api/agent/critique", json={"sections": SECTIONS, "doc_title": "引用核查助手", "max_rounds": 3}))
    tid = events[0]["thread_id"]
    intr = next(e for e in events if e["type"] == "interrupt")["value"]
    assert intr["kind"] == "revise" and intr["round"] == 1 and intr["max_rounds"] == 3
    issues = intr["issues"]
    cats = {i["category"] for i in issues}
    assert {"logic", "overclaim", "structure"} <= cats
    full = re.sub(r"\[@[^\]]*\]", "", "".join(s["text"] for s in SECTIONS))
    for i in issues:
        assert i["id"].startswith("r1-") and i["severity"] in ("major", "minor") and i["comment"]
        # 每条意见要么挂在原文里逐字存在的句子上，要么是整节意见
        assert i["anchor"] == "" or i["anchor"].replace(" ", "") in full.replace(" ", "")
    assert intr["history"][0]["round"] == 1 and intr["summary"]
    assert any("通读全文" in e.get("message", "") for e in events if e["type"] == "progress")

    st = client.get(f"/api/agent/{tid}").json()
    assert st["kind"] == "critique" and st["interrupt"]["kind"] == "revise"

    # 作者：改掉过度的那句，对结构问题给出理由，其余不处理
    over = next(i for i in issues if i["category"] == "overclaim")
    struct = next(i for i in issues if i["category"] == "structure")
    new_sections = [
        {"title": "1 引言", "text": SECTIONS[0]["text"].replace(over["anchor"], "初步实验表明，本文的方法可以提高引用的准确率。")},
        SECTIONS[1],
    ]
    responses = {over["id"]: {"status": "fixed"}, struct["id"]: {"status": "rebut", "note": "方法细节放在附录"}}
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "again", "sections": new_sections, "responses": responses}}))
    intr = next(e for e in events if e["type"] == "interrupt")["value"]
    assert intr["round"] == 2
    resolved = {i["id"] for i in intr["resolved"]}
    assert over["id"] in resolved and struct["id"] in resolved  # 改掉的、理由成立的都算解决
    open_ids = {i["id"] for i in intr["issues"]}
    assert open_ids and not (open_ids & resolved)
    assert all(i["followup"]["round"] == 2 for i in intr["issues"])
    assert intr["history"][1]["resolved"] == 2

    # 结束
    events = sse(client.post(f"/api/agent/{tid}/resume", json={"value": {"action": "stop"}}))
    done = events[-1]
    assert done["type"] == "done" and done["result"]["kind"] == "critique" and done["result"]["round"] == 2
    assert any(t["thread_id"] == tid and t["kind"] == "critique" for t in client.get("/api/agent").json())


def test_critique_stops_at_max_rounds():
    events = sse(client.post("/api/agent/critique", json={"sections": SECTIONS, "max_rounds": 1}))
    assert not any(e["type"] == "interrupt" for e in events)
    done = events[-1]
    assert done["type"] == "done" and done["result"]["round"] == 1 and done["result"]["issues"]


def test_critique_requires_text():
    assert client.post("/api/agent/critique", json={"sections": [{"title": "空", "text": "  "}]}).status_code == 422
    assert client.post("/api/agent/critique", json={"sections": []}).status_code == 422


def test_stop_and_continue():
    events = sse(client.post("/api/agent/critique", json={"sections": SECTIONS}))
    tid = events[0]["thread_id"]
    status = lambda: next(t for t in client.get("/api/agent").json() if t["thread_id"] == tid)["status"]  # noqa: E731
    # 在等你确认的任务不会被「停止」改掉状态，也不能用空值继续
    assert client.post(f"/api/agent/{tid}/stop").json()["ok"] and status() == "waiting"
    assert client.post(f"/api/agent/{tid}/resume", json={"value": {}}).status_code == 409
    # 运行中被停止：标记为 stopped
    from app.db import get_conn
    with get_conn() as conn:
        conn.execute("UPDATE agent_threads SET status='running' WHERE thread_id=?", (tid,))
    client.post(f"/api/agent/{tid}/stop")
    assert status() == "stopped"
