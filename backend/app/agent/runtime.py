"""Own graph execution outside the HTTP stream and serialize runs per task.

Only the dedicated worker creates, advances and closes graph iterators. An SSE
disconnect requests a stop; it never finalizes a graph inside an unrelated
thread pool's submit()/GC stack. Stops take effect at checkpoint boundaries.
"""
from __future__ import annotations

import asyncio
import queue
import threading
import time
from collections.abc import Callable

from fastapi import HTTPException
from fastapi.responses import StreamingResponse


class AgentRun:
    def __init__(self, tid: str):
        self.tid = tid
        self.stop_requested = threading.Event()
        self.disconnected = threading.Event()
        self.finished = threading.Event()
        self.events: queue.Queue[dict] = queue.Queue(maxsize=256)

    def emit(self, event: dict) -> None:
        deadline = time.monotonic() + 10
        while True:
            if self.disconnected.is_set():
                return
            try:
                self.events.put(event, timeout=0.1)
                return
            except queue.Full:
                # No consumer for ten seconds: stop at the next checkpoint.
                if time.monotonic() >= deadline:
                    self.disconnected.set()
                    self.stop_requested.set()
                    return

    def start(self, target: Callable[[AgentRun], None]) -> None:
        def work() -> None:
            try:
                target(self)
            finally:
                release(self)
                self.finished.set()

        try:
            threading.Thread(target=work, name=f"agent-{self.tid}", daemon=True).start()
        except BaseException:
            release(self)
            self.finished.set()
            raise

    def response(self) -> StreamingResponse:
        # Import here to keep the execution registry independent of router setup.
        from ..routers.sse import sse_event

        async def body():
            heartbeat = time.monotonic()
            try:
                while not self.finished.is_set() or not self.events.empty():
                    try:
                        event = self.events.get_nowait()
                    except queue.Empty:
                        if time.monotonic() - heartbeat >= 10:
                            yield ": keep-alive\n\n"
                            heartbeat = time.monotonic()
                        await asyncio.sleep(0.02)
                        continue
                    yield sse_event(event)
            finally:
                self.disconnected.set()
                self.stop_requested.set()

        return _AgentResponse(self, body(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
        })


class _AgentResponse(StreamingResponse):
    def __init__(self, run: AgentRun, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.run = run

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # ASGI can disconnect while send() is suspended at a yielded chunk,
            # before the body iterator's own finally block would be resumed.
            self.run.disconnected.set()
            self.run.stop_requested.set()
            await self.body_iterator.aclose()


_lock = threading.Lock()
_active: dict[str, AgentRun] = {}


def reserve(tid: str) -> AgentRun:
    with _lock:
        if tid in _active:
            raise HTTPException(409, "该任务仍在运行或正在停止，请等待当前步骤保存后再继续")
        run = AgentRun(tid)
        _active[tid] = run
        return run


def release(run: AgentRun) -> None:
    with _lock:
        if _active.get(run.tid) is run:
            del _active[run.tid]


def active(tid: str) -> AgentRun | None:
    with _lock:
        return _active.get(tid)
