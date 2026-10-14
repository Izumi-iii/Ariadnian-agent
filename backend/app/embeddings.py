"""可选的向量嵌入（EMBEDDING_PROVIDER=ollama|openai）。默认 none：只用 BM25，零依赖即可工作。"""
from __future__ import annotations

import numpy as np
import requests

from .config import get_settings


def embeddings_enabled() -> bool:
    return get_settings().embedding_provider in {"ollama", "openai"}


def embed_texts(texts: list[str], batch: int = 32) -> list[np.ndarray]:
    s = get_settings()
    out: list[np.ndarray] = []
    for i in range(0, len(texts), batch):
        part = texts[i : i + batch]
        if s.embedding_provider == "ollama":
            base = (s.embedding_base_url or "http://localhost:11434").rstrip("/")
            r = requests.post(f"{base}/api/embed", json={"model": s.embedding_model, "input": part}, timeout=120)
            r.raise_for_status()
            vecs = r.json().get("embeddings", [])
        elif s.embedding_provider == "openai":
            from openai import OpenAI

            client = OpenAI(api_key=s.embedding_api_key, base_url=s.embedding_base_url)
            vecs = [d.embedding for d in client.embeddings.create(model=s.embedding_model, input=part).data]
        else:
            raise RuntimeError("embedding provider 未启用")
        if len(vecs) != len(part):
            raise RuntimeError(f"嵌入数量不匹配：{len(vecs)} vs {len(part)}")
        out.extend(np.asarray(v, dtype=np.float32) for v in vecs)
    return out


def to_blob(v: np.ndarray) -> bytes:
    return np.asarray(v, dtype=np.float32).tobytes()


def from_blob(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32)
