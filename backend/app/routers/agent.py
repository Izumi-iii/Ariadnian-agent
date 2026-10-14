from __future__ import annotations

import uuid
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException
from langgraph.types import Command
from pydantic import BaseModel, Field

from ..agent.graph import get_graph
from ..db import get_conn
from .sse import sse_response

router = APIRouter(prefix="/api/agent", tags=["agent"])

NODE_LABELS = {
    "plan_queries": "拆解检索式",
    "search_papers": "检索文献",
    "select_papers": "勾选文献",
    "ingest": "加入文献库",
    "synthesize": "归纳研究现状",
    "make_outline": "生成大纲",
    "review_outline": "确认大纲",
    "finish": "完成",
}


class StartIn(BaseModel):
    topic: str = Field(..., min_length=2)
    doc_id: str | None = None
    language: str = "zh"
    paper_type: str = "学术论文"
    sources: list[str] = Field(default_factory=lambda: ["semantic_scholar", "arxiv"])
    max_papers: int = 8
    fetch_pdf: bool = True


class ResumeIn(BaseModel):
    value: dict[str, Any]


def _set_status(tid: str, status: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE agent_threads SET status=?, updated_at=datetime('now') WHERE thread_id=?", (status, tid))


def _result(values: dict) -> dict:
    return {k: values.get(k) for k in ("topic", "outline", "synthesis", "notes", "paper_ids", "errors")}


def _run(tid: str, payload: Any) -> Iterator[dict]:
    graph = get_graph()
    config = {"configurable": {"thread_id": tid}}
    _set_status(tid, "running")
    yield {"type": "status", "status": "running", "thread_id": tid}
    try:
        for mode, chunk in graph.stream(payload, config, stream_mode=["updates", "custom"]):
            if mode == "custom":
                yield {"type": "progress", **chunk}
                continue
            for node, update in chunk.items():
                if node == "__interrupt__":
                    yield {"type": "interrupt", "value": update[0].value}
                else:
                    yield {"type": "node", "node": node, "label": NODE_LABELS.get(node, node)}
        snap = graph.get_state(config)
        if snap.next:
            _set_status(tid, "waiting")
            yield {"type": "status", "status": "waiting"}
        else:
            _set_status(tid, "done")
            yield {"type": "done", "result": _result(snap.values)}
    except Exception as e:  # noqa: BLE001
        _set_status(tid, "error")
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}


@router.post("/start")
def start(body: StartIn):
    tid = uuid.uuid4().hex[:16]
    with get_conn() as conn:
        conn.execute("INSERT INTO agent_threads (thread_id, doc_id, topic) VALUES (?,?,?)", (tid, body.doc_id, body.topic))
    state = body.model_dump(exclude={"doc_id"})
    return sse_response(_run(tid, state))


@router.post("/{tid}/resume")
def resume(tid: str, body: ResumeIn):
    graph = get_graph()
    snap = graph.get_state({"configurable": {"thread_id": tid}})
    if not snap.next:
        raise HTTPException(409, "该任务没有在等待输入")
    return sse_response(_run(tid, Command(resume=body.value)))


@router.get("")
def list_threads(doc_id: str | None = None):
    with get_conn() as conn:
        if doc_id:
            rows = conn.execute(
                "SELECT * FROM agent_threads WHERE doc_id=? ORDER BY created_at DESC LIMIT 20", (doc_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM agent_threads ORDER BY created_at DESC LIMIT 20").fetchall()
    return [dict(r) for r in rows]


@router.get("/{tid}")
def get_thread(tid: str):
    graph = get_graph()
    snap = graph.get_state({"configurable": {"thread_id": tid}})
    if not snap.values:
        raise HTTPException(404, "任务不存在")
    pending = None
    for task in snap.tasks:
        if task.interrupts:
            pending = task.interrupts[0].value
            break
    with get_conn() as conn:
        row = conn.execute("SELECT status FROM agent_threads WHERE thread_id=?", (tid,)).fetchone()
    return {
        "thread_id": tid,
        "status": row["status"] if row else ("waiting" if pending else "done"),
        "interrupt": pending,
        "result": _result(snap.values),
    }
