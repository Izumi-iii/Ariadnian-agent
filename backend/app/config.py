"""运行时配置：从 backend/.env 或仓库根目录 .env 读取。

模型按任务分四档（每档都是一个 LiteLLM 模型名，如 deepseek/deepseek-chat、openai/mimo-v2.5-pro、ollama_chat/qwen2.5:7b）：

    complete  行内续写   —— 要快，量最大
    write     改写 / 问答 —— 质量优先，流式输出
    judge     引用判断 / 跨语言关键词 —— 稳定、便宜
    agent     综述与大纲 —— 长上下文、稳定输出 JSON

兼容旧版字段：MODEL_PROVIDER + MODEL_ID + FAST_MODEL_ID + OPENAI_API_KEY + OPENAI_BASE_URL。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

load_dotenv(BACKEND_DIR / ".env")
load_dotenv(REPO_DIR / ".env")

TIERS = ("complete", "write", "judge", "agent")

# 每档默认的超时（秒）和重试次数：补全超时就放弃，不打扰用户；Agent 任务允许久一点
_TIER_DEFAULTS = {
    "complete": {"timeout": 8, "retries": 0},
    "write": {"timeout": 90, "retries": 1},
    "judge": {"timeout": 30, "retries": 2},
    "agent": {"timeout": 180, "retries": 2},
}


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return default if value is None or value.strip() == "" else value.strip()


def _truthy(value: str | None) -> bool:
    return (value or "").lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class ModelTier:
    name: str
    model: str  # 原始模型名，由 llm.resolve_model 补全 provider 前缀
    api_key: str | None
    api_base: str | None
    timeout: float
    retries: int
    fallbacks: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class Settings:
    provider: str  # 旧版 MODEL_PROVIDER，用于给没有前缀的模型名补前缀
    tiers: dict[str, ModelTier]
    llm_fake: bool

    embedding_provider: str  # none | ollama | openai
    embedding_model: str
    embedding_base_url: str | None
    embedding_api_key: str | None

    semantic_scholar_api_key: str | None
    data_dir: Path
    cors_origins: list[str]

    @property
    def llm_ready(self) -> bool:
        if self.llm_fake:
            return True
        return all(t.api_key or t.model.startswith(("ollama/", "ollama_chat/")) or self.provider == "ollama"
                   for t in self.tiers.values())


def _build_tier(name: str, provider: str, main: str, fast: str, key: str | None, base: str | None) -> ModelTier:
    up = name.upper()
    default_model = fast if name in ("complete", "judge") else main
    d = _TIER_DEFAULTS[name]
    return ModelTier(
        name=name,
        model=_env(f"MODEL_{up}", default_model) or default_model,
        api_key=_env(f"MODEL_{up}_API_KEY", key),
        api_base=_env(f"MODEL_{up}_API_BASE", base),
        timeout=float(_env(f"MODEL_{up}_TIMEOUT", str(d["timeout"])) or d["timeout"]),
        retries=int(_env(f"MODEL_{up}_RETRIES", str(d["retries"])) or d["retries"]),
        fallbacks=tuple(m.strip() for m in (_env(f"MODEL_{up}_FALLBACKS", "") or "").split(",") if m.strip()),
    )


@lru_cache
def get_settings() -> Settings:
    provider = (_env("MODEL_PROVIDER", "openai_like") or "openai_like").lower()
    main = _env("MODEL_ID", "deepseek/deepseek-chat") or "deepseek/deepseek-chat"
    fast = _env("FAST_MODEL_ID", main) or main
    key = _env("LLM_API_KEY", _env("OPENAI_API_KEY"))
    base = _env("LLM_API_BASE", _env("OPENAI_BASE_URL"))
    if provider == "ollama" and not base:
        base = _env("OLLAMA_HOST", "http://localhost:11434")

    data_dir = Path(_env("ARIA_DATA_DIR", str(BACKEND_DIR / "data")) or "data")
    data_dir.mkdir(parents=True, exist_ok=True)

    emb_provider = (_env("EMBEDDING_PROVIDER", "none") or "none").lower()
    emb_base = _env("EMBEDDING_BASE_URL")
    if emb_provider == "ollama" and not emb_base:
        emb_base = _env("EMBEDDING_HOST", _env("OLLAMA_HOST", "http://localhost:11434"))

    return Settings(
        provider=provider,
        tiers={t: _build_tier(t, provider, main, fast, key, base) for t in TIERS},
        llm_fake=_truthy(_env("LLM_FAKE")),
        embedding_provider=emb_provider,
        embedding_model=_env("EMBEDDING_MODEL", "nomic-embed-text") or "nomic-embed-text",
        embedding_base_url=emb_base if emb_provider == "ollama" else (emb_base or base),
        embedding_api_key=_env("EMBEDDING_API_KEY", key),
        semantic_scholar_api_key=_env("SEMANTIC_SCHOLAR_API_KEY"),
        data_dir=data_dir,
        cors_origins=(_env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173") or "").split(","),
    )
