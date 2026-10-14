from __future__ import annotations

import json
from typing import Any, Iterable, Iterator

from fastapi.responses import StreamingResponse


def sse_event(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def sse_response(events: Iterable[dict[str, Any]]) -> StreamingResponse:
    def gen() -> Iterator[str]:
        try:
            for e in events:
                yield sse_event(e)
        except Exception as e:  # noqa: BLE001
            yield sse_event({"type": "error", "message": str(e)})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
