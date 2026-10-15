from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import assist
from ..llm import LLMNotConfigured
from .sse import sse_response

router = APIRouter(prefix="/api/assist", tags=["assist"])


class CompleteIn(BaseModel):
    before: str
    after: str = ""
    title: str = ""
    section: str = ""
    use_library: bool = True


class EditIn(BaseModel):
    text: str
    action: str = "polish"
    instruction: str = ""
    context: str = ""


class CiteIn(BaseModel):
    sentence: str
    k: int = 5
    judge: bool = True


class VerifyIn(BaseModel):
    sentence: str
    paper_ids: list[str]


class AnnotateIn(BaseModel):
    paragraph: str
    title: str = ""
    check_citations: bool = True
    review: bool = True


class AskIn(BaseModel):
    question: str
    k: int = 6


@router.post("/complete")
def complete(body: CompleteIn):
    try:
        return {"text": assist.complete(body.before, body.after, body.title, body.section, body.use_library)}
    except LLMNotConfigured as e:
        raise HTTPException(503, str(e)) from e


@router.post("/edit")
def edit(body: EditIn):
    if not body.text.strip():
        raise HTTPException(400, "没有选中文字")

    def events():
        for tok in assist.edit_stream(body.text, body.action, body.instruction, body.context):
            yield {"type": "token", "text": tok}
        yield {"type": "done"}

    return sse_response(events())


@router.post("/cite")
def cite(body: CiteIn):
    return {"candidates": assist.suggest_citations(body.sentence, body.k, body.judge)}


@router.post("/verify")
def verify(body: VerifyIn):
    return {"results": [assist.verify_citation(body.sentence, pid) for pid in body.paper_ids]}


@router.post("/ask")
def ask(body: AskIn):
    def events():
        sources, stream = assist.ask_stream(body.question, body.k)
        yield {"type": "sources", "sources": sources}
        for tok in stream:
            yield {"type": "token", "text": tok}
        yield {"type": "done"}

    return sse_response(events())


@router.post("/annotate")
def annotate(body: AnnotateIn):
    """页边批注：对一个段落做引用核查、缺引用检测和精简建议。"""
    try:
        return {"annotations": assist.annotate(body.paragraph, body.title, body.check_citations, body.review)}
    except LLMNotConfigured as e:
        raise HTTPException(503, str(e)) from e

