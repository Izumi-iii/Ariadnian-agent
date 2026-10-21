from __future__ import annotations

import json
import time
import uuid
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException
from langgraph.types import Command
from pydantic import BaseModel, Field

from ..agent.graph import get_graph
from ..agent.critic import get_critic
from ..agent.writer import get_writer
from .. import runstats
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
    # 分节写作
    "prepare": "准备",
    "write_section": "写作本节",
    "review_section": "确认本节",
    "advance": "下一节",
    "write_one": "子 Agent 写作",
    "collect": "汇总",
    "polish": "总编统稿",
    # 审稿
    "review": "审稿",
    "await_revision": "等你修改",
}


class StartIn(BaseModel):
    topic: str = Field(..., min_length=2)
    doc_id: str | None = None
    language: str = "zh"
    paper_type: str = "学术论文"
    sources: list[str] | None = None  # 不传则使用设置里的默认来源
    max_papers: int = 8
    fetch_pdf: bool = True


class SectionIn(BaseModel):
    title: str = Field(..., min_length=1)
    goal: str = ""
    bibkeys: list[str] = Field(default_factory=list)


class WriteIn(BaseModel):
    doc_id: str | None = None
    topic: str = ""
    doc_title: str = ""
    language: str = "zh"
    paper_type: str = "学术论文"
    outline: list[SectionIn] = Field(..., min_length=1, max_length=20)
    mode: str = "confirm"  # confirm=每节写完停下来确认；auto=连续写完；parallel=子 Agent 并行写
    length: str = "medium"  # short / medium / long
    selected: list[int] | None = None  # 要写的章节（大纲下标），不传 = 全部
    polish: bool = False  # 写完后由总编统稿


class DocSectionIn(BaseModel):
    title: str = ""
    text: str = ""


class CritiqueIn(BaseModel):
    doc_id: str | None = None
    doc_title: str = ""
    language: str = "zh"
    paper_type: str = "学术论文"
    focus: str = ""
    sections: list[DocSectionIn] = Field(..., min_length=1, max_length=60)
    max_rounds: int = Field(3, ge=1, le=5)


class ResumeIn(BaseModel):
    value: dict[str, Any]


def _set_status(tid: str, status: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE agent_threads SET status=?, updated_at=datetime('now') WHERE thread_id=?", (status, tid))


def _kind(tid: str) -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT kind FROM agent_threads WHERE thread_id=?", (tid,)).fetchone()
    return row["kind"] if row else "review"


def _graph_for(tid: str):
    k = _kind(tid)
    return get_writer() if k == "write" else get_critic() if k == "critique" else get_graph()


def _result(values: dict) -> dict:
    if "max_rounds" in values:  # 审稿
        keys = ("round", "max_rounds", "summary", "verdict", "scores", "issues", "resolved", "history", "errors")
        return {k: values.get(k) for k in keys} | {"kind": "critique"}
    if "drafts" in values:  # 分节写作
        keys = ("topic", "outline", "drafts", "mode", "order", "polish", "edits", "polish_summary", "errors")
        return {k: values.get(k) for k in keys} | {"kind": "write"}
    return {k: values.get(k) for k in ("topic", "outline", "synthesis", "notes", "paper_ids", "errors")} | {"kind": "review"}


def _run(tid: str, payload: Any) -> Iterator[dict]:
    graph = _graph_for(tid)
    config = {"configurable": {"thread_id": tid}}
    meter = runstats.RunMeter(tid, runstats.load(tid))  # 继续的任务接着上次的统计累计
    _set_status(tid, "running")
    yield {"type": "status", "status": "running", "thread_id": tid}
    yield {"type": "stats", "stats": meter.snapshot()}
    last = [time.perf_counter(), meter.version]

    def tick(force: bool = False) -> dict | None:
        """统计有变化时最多每 0.5 秒推一次，避免刷屏"""
        now = time.perf_counter()
        if force or (meter.version != last[1] and now - last[0] >= 0.5):
            last[0], last[1] = now, meter.version
            return {"type": "stats", "stats": meter.snapshot()}
        return None

    try:
        for mode, chunk in runstats.bind(meter, graph.stream(payload, config, stream_mode=["updates", "custom"])):
            if mode == "custom":
                yield {"type": "progress", **chunk}
            else:
                for node, update in chunk.items():
                    if node == "__interrupt__":
                        yield {"type": "interrupt", "value": update[0].value}
                    else:
                        meter.step()
                        yield {"type": "node", "node": node, "label": NODE_LABELS.get(node, node)}
            if (e := tick()) is not None:
                yield e
        meter.stop_clock()
        yield tick(force=True)
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
    finally:  # 正常结束、出错、前端断开（停止）都保存统计
        meter.stop_clock()
        runstats.save(meter)


@router.post("/start")
def start(body: StartIn):
    tid = uuid.uuid4().hex[:16]
    with get_conn() as conn:
        conn.execute("INSERT INTO agent_threads (thread_id, doc_id, topic) VALUES (?,?,?)", (tid, body.doc_id, body.topic))
    state = body.model_dump(exclude={"doc_id"})
    return sse_response(_run(tid, state))


@router.post("/write")
def write(body: WriteIn):
    """分节写作：写选中的章节（逐节确认 / 连续写完 / 子 Agent 并行），可选总编统稿；草稿流式输出"""
    picked = sorted({i for i in body.selected if 0 <= i < len(body.outline)}) if body.selected is not None else list(range(len(body.outline)))
    if not picked:
        raise HTTPException(422, "至少选择一节")
    tid = uuid.uuid4().hex[:16]
    titles = "、".join(body.outline[i].title for i in picked[:3]) + ("…" if len(picked) > 3 else "")
    with get_conn() as conn:
        conn.execute("INSERT INTO agent_threads (thread_id, doc_id, topic, kind) VALUES (?,?,?,?)",
                     (tid, body.doc_id, f"分节写作：{titles}", "write"))
    state = body.model_dump(exclude={"doc_id"}) | {"selected": picked}
    state["mode"] = body.mode if body.mode in ("auto", "parallel") else "confirm"
    state["length"] = body.length if body.length in ("short", "medium", "long") else "medium"
    return sse_response(_run(tid, state))


@router.post("/critique")
def critique(body: CritiqueIn):
    """审稿：审全文 → 作者修改并回复 → 再审，最多 max_rounds 轮"""
    sections = [s.model_dump() for s in body.sections if s.text.strip()]
    if not sections:
        raise HTTPException(422, "文档还没有正文，写一些内容后再审稿")
    tid = uuid.uuid4().hex[:16]
    with get_conn() as conn:
        conn.execute("INSERT INTO agent_threads (thread_id, doc_id, topic, kind) VALUES (?,?,?,?)",
                     (tid, body.doc_id, f"审稿：{body.doc_title or '未命名论文'}", "critique"))
    state = body.model_dump(exclude={"doc_id"}) | {"sections": sections, "round": 0}
    return sse_response(_run(tid, state))


@router.post("/{tid}/resume")
def resume(tid: str, body: ResumeIn):
    graph = _graph_for(tid)
    snap = graph.get_state({"configurable": {"thread_id": tid}})
    if not snap.next:
        raise HTTPException(409, "该任务没有在等待输入")
    waiting = any(t.interrupts for t in snap.tasks)
    if waiting and not body.value:
        raise HTTPException(409, "任务在等你确认，请先在卡片上做出选择")
    # 没有在等输入、但还有没跑完的节点（中途被停止）：从上次的检查点接着跑
    return sse_response(_run(tid, Command(resume=body.value) if waiting else None))


@router.post("/{tid}/stop")
def stop(tid: str):
    """前端断开流之后调用：标记为已停止（图会在当前步骤结束后不再继续），之后可以从检查点继续"""
    with get_conn() as conn:  # 只有正在跑的任务才标记为停止；等你确认的保持原状
        conn.execute("UPDATE agent_threads SET status='stopped', updated_at=datetime('now') WHERE thread_id=? AND status='running'", (tid,))
    return {"ok": True}


@router.get("")
def list_threads(doc_id: str | None = None):
    with get_conn() as conn:
        if doc_id:
            rows = conn.execute(
                "SELECT * FROM agent_threads WHERE doc_id=? ORDER BY created_at DESC LIMIT 20", (doc_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM agent_threads ORDER BY created_at DESC LIMIT 20").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        st = json.loads(d.pop("stats") or "null") if d.get("stats") else None
        d["tokens"] = (st or {}).get("total_tokens")  # 历史列表只需要总量
        out.append(d)
    return out


@router.get("/{tid}/stats")
def thread_stats(tid: str):
    """任务的运行统计（历史任务回看时用）；没有记录时返回 null"""
    return runstats.load(tid)


@router.get("/{tid}")
def get_thread(tid: str):
    graph = _graph_for(tid)
    snap = graph.get_state({"configurable": {"thread_id": tid}})
    if not snap.values:
        raise HTTPException(404, "任务不存在")
    pending = None
    for task in snap.tasks:
        if task.interrupts:
            pending = task.interrupts[0].value
            break
    with get_conn() as conn:
        row = conn.execute("SELECT status, kind FROM agent_threads WHERE thread_id=?", (tid,)).fetchone()
    return {
        "stats": runstats.load(tid),
        "thread_id": tid,
        "kind": row["kind"] if row else "review",
        "status": row["status"] if row else ("waiting" if pending else "done"),
        "interrupt": pending,
        "result": _result(snap.values),
    }
