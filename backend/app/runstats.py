"""Agent 运行统计：一次任务（含中途停下、确认后继续）里所有模型调用的 token、速度、缓存命中和上下文占用。

llm.py 每次调用结束都会调用 record()；当前属于哪个任务由 contextvar 决定（routers/agent.py 在推进图的
每一步前设置）。LangGraph 的执行器会复制 contextvars，所以子 Agent 并行写作时的调用也会记到同一个任务上。
统计随 SSE 实时推给前端（type=stats），任务暂停 / 结束时存到 agent_threads.stats，下次继续时接着累计。
"""
from __future__ import annotations

import json
import threading
import time
from contextvars import ContextVar
from functools import lru_cache
from typing import Any, Iterator

_current: ContextVar["RunMeter | None"] = ContextVar("ariadne_run_meter", default=None)

_FIELDS = ("calls", "failed", "steps", "prompt_tokens", "completion_tokens", "cached_tokens", "cache_known_prompt",
           "gen_ms", "rate_tokens", "cost_usd", "elapsed_ms")


@lru_cache(maxsize=64)
def context_window(model: str) -> int | None:
    """模型的最大输入长度；LiteLLM 不认识的模型（自建服务、新模型）返回 None"""
    try:
        import litellm

        info = litellm.get_model_info(model)
        v = info.get("max_input_tokens") or info.get("max_tokens")
        return int(v) if v else None
    except Exception:  # noqa: BLE001
        return None


def _load_of(c: dict) -> float:
    """上下文占用：知道窗口大小时用比例，否则按 token 数（不同模型混用时以比例为准）"""
    return c["used"] / c["max"] if c.get("max") else c["used"] / 1e9


class RunMeter:
    def __init__(self, thread_id: str, saved: dict | None = None):
        self.thread_id = thread_id
        self._lock = threading.Lock()
        s = saved or {}
        self.v: dict[str, Any] = {k: s.get(k) or 0 for k in _FIELDS}
        self.context: dict | None = s.get("context")  # 最近一次调用 {used, max, model}
        self.peak: dict | None = s.get("peak_context")  # 占用比例最高的一次
        self.models: dict[str, int] = dict(s.get("models") or {})
        self._streams: dict[int, tuple[float, int]] = {}  # 正在流式输出的调用：开始时间、已收到的片段数
        self._t0 = time.perf_counter()
        self._elapsed0 = self.v["elapsed_ms"]
        self.version = 0

    # ---- llm.py 调用 ----
    def stream_tick(self, key: int, started: float) -> None:
        with self._lock:
            t, n = self._streams.get(key, (started, 0))
            self._streams[key] = (t, n + 1)
            self.version += 1

    def record(self, model: str, *, ok: bool, latency: float, first_token: float | None, prompt_tokens: int | None,
               completion_tokens: int | None, cached_tokens: int | None, cost: float | None, stream_key: int | None = None) -> None:
        with self._lock:
            if stream_key is not None:
                self._streams.pop(stream_key, None)
            self.v["calls"] += 1
            self.version += 1
            if not ok:
                self.v["failed"] += 1
                return
            pt, ct = prompt_tokens or 0, completion_tokens or 0
            self.v["prompt_tokens"] += pt
            self.v["completion_tokens"] += ct
            if cached_tokens is not None:  # 只有返回了缓存字段的调用才计入命中率的分母
                self.v["cached_tokens"] += cached_tokens
                self.v["cache_known_prompt"] += pt
            gen = latency - (first_token or 0) if first_token is not None else latency
            if ct and gen >= 0.05:  # 太短的（离线演示、缓存直出）不计入速度
                self.v["gen_ms"] += int(gen * 1000)
                self.v["rate_tokens"] += ct
            if cost:
                self.v["cost_usd"] += cost
            self.models[model] = self.models.get(model, 0) + 1
            if pt:
                mx = context_window(model)
                self.context = {"used": pt, "max": mx, "model": model}
                if self.peak is None or _load_of(self.context) > _load_of(self.peak):
                    self.peak = dict(self.context)

    # ---- 路由调用 ----
    def step(self) -> None:
        with self._lock:
            self.v["steps"] += 1
            self.version += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            v = dict(self.v)
            now = time.perf_counter()
            v["elapsed_ms"] = self._elapsed0 + int((now - self._t0) * 1000)
            out = v["completion_tokens"]
            v["tok_s"] = round(v["rate_tokens"] / (v["gen_ms"] / 1000), 1) if v["gen_ms"] else None
            # 正在输出的调用：按收到的片段数估算实时速度（大多数服务一个片段约一个 token）
            live = [(n, now - t) for t, n in self._streams.values() if n > 3 and now - t > 0.3]
            v["live_tok_s"] = round(sum(n / d for n, d in live), 1) if live else None
            v["streaming"] = len(self._streams)
            v["total_tokens"] = v["prompt_tokens"] + out
            v["cache_hit"] = round(v["cached_tokens"] / v["cache_known_prompt"], 3) if v["cache_known_prompt"] else None
            v["cost_usd"] = round(v["cost_usd"], 6) if v["cost_usd"] else None
            v["context"] = self.context
            v["peak_context"] = self.peak
            v["models"] = dict(self.models)
            return v

    def stop_clock(self) -> None:
        """暂停（等用户确认）时停表：等待的时间不算运行时间"""
        with self._lock:
            self._elapsed0 += int((time.perf_counter() - self._t0) * 1000)
            self._t0 = time.perf_counter()
            self.v["elapsed_ms"] = self._elapsed0


def current() -> RunMeter | None:
    return _current.get()


def bind(meter: RunMeter, it: Iterator[Any]) -> Iterator[Any]:
    """推进生成器的每一步时都把 meter 设为当前任务（SSE 每次取下一条事件可能在不同线程上下文里）"""
    while True:
        tok = _current.set(meter)
        try:
            item = next(it)
        except StopIteration:
            return
        finally:
            _current.reset(tok)
        yield item


def load(thread_id: str) -> dict | None:
    from .db import get_conn

    with get_conn() as conn:
        row = conn.execute("SELECT stats FROM agent_threads WHERE thread_id=?", (thread_id,)).fetchone()
    if not row or not row["stats"]:
        return None
    try:
        return json.loads(row["stats"])
    except ValueError:
        return None


def save(meter: RunMeter) -> None:
    from .db import get_conn

    try:
        snap = meter.snapshot()
        snap.pop("live_tok_s", None)
        snap.pop("streaming", None)
        with get_conn() as conn:
            conn.execute("UPDATE agent_threads SET stats=? WHERE thread_id=?", (json.dumps(snap), meter.thread_id))
    except Exception:  # noqa: BLE001  统计失败不能影响任务
        pass
