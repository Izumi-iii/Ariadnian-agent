"""Ariadne 研究报告助手 · 后端入口

    cd backend
    uv sync
    uv run uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import init_db
from .embeddings import embeddings_enabled
from .llm import stats, tier_info
from .routers import agent, assist, documents, papers, settings as settings_router

settings = get_settings()
init_db()

app = FastAPI(title="Ariadne Research Report Assistant", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(papers.router)
app.include_router(documents.router)
app.include_router(assist.router)
app.include_router(agent.router)
app.include_router(settings_router.router)


@app.get("/api/health")
def health():
    settings = get_settings()  # 网页里改了设置会立即反映
    tiers = tier_info()
    return {
        "ok": True,
        "llm_ready": settings.llm_ready,
        "fake": settings.llm_fake,
        "model": tiers["write"]["model"],
        "tiers": tiers,
        "embedding": settings.embedding_model if embeddings_enabled() else None,
    }


@app.get("/api/llm/stats")
def llm_stats(days: int = 30):
    """各档模型的调用次数、P50/P95 耗时、首 token 延迟、token 与费用。"""
    return stats(days)


# 生产模式：前端 build 后由后端直接托管（npm run build → frontend/dist）
# 桌面版打包后目录结构不同，由启动器通过 ARIA_FRONTEND_DIST 指定
_dist = Path(os.getenv("ARIA_FRONTEND_DIST") or Path(__file__).resolve().parents[2] / "frontend" / "dist").resolve()
if (_dist / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = (_dist / path).resolve()
        # 只返回 dist 目录里的文件，防止 ../ 越界
        ok = path and f.is_file() and f.is_relative_to(_dist)
        return FileResponse(f if ok else _dist / "index.html")
