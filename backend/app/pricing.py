"""模型价格表与费用计算（人民币 / 百万 tokens）。

- 内置价格来自各家官网价格页，带来源和核对日期；价格会变，以官网为准。
- 网页「设置 → 用量统计」里可以为任意模型填写自定义价格（存为 MODEL_PRICES），优先于内置价格。
- 费用 = 未命中缓存的输入 × 输入单价 + 命中缓存的输入 × 缓存单价 + 输出 × 输出单价。
  推理模型的思考过程计入输出 tokens。
- DeepSeek 分高峰 / 空闲时段计价：北京时间工作日 9:00–12:00、14:00–18:00 为高峰（价格翻倍），
  其余时间为空闲时段。法定节假日按空闲计价，这里无法识别节假日，会按工作日计。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import _env

CHECKED = "2026-10-15"


@dataclass(frozen=True)
class Price:
    input: float          # 输入（缓存未命中）
    cached: float         # 输入（缓存命中）
    output: float         # 输出
    peak_multiplier: float = 1.0  # 高峰时段倍率（只有 DeepSeek 用到）
    source: str = ""
    note: str = ""


_DS = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
_KIMI = "https://platform.kimi.com/docs/pricing/chat"

# 键为去掉 provider 前缀后的模型名，小写
BUILTIN: dict[str, Price] = {
    # DeepSeek：表中是空闲时段价格，高峰时段 ×2
    "deepseek-flash": Price(1.0, 0.02, 4.0, 2.0, _DS, "默认开启思考模式"),
    "deepseek-v4-flash": Price(1.0, 0.02, 4.0, 2.0, _DS, "旧模型名，按 Flash 计费"),
    "deepseek-v4-pro": Price(4.5, 0.15, 13.5, 2.0, _DS, "默认开启思考模式"),
    # Kimi
    "kimi-k3": Price(20.0, 2.0, 100.0, 1.0, _KIMI),
    "kimi-k2.7-code": Price(6.5, 1.3, 27.0, 1.0, _KIMI),
    "kimi-k2.7-code-highspeed": Price(13.0, 2.6, 54.0, 1.0, _KIMI),
    "kimi-k2.6": Price(6.5, 1.1, 27.0, 1.0, _KIMI),
}

# 各服务商官网价格页（设置页里给用户参考）
PRICING_PAGES = {
    "DeepSeek": _DS,
    "Kimi": _KIMI,
    "通义千问（阿里云百炼）": "https://help.aliyun.com/zh/model-studio/models",
    "智谱 GLM": "https://bigmodel.cn/pricing",
}

_BJ = timezone(timedelta(hours=8))


def model_key(model: str) -> str:
    """openai/deepseek-flash → deepseek-flash；ollama_chat/qwen2.5:7b → qwen2.5:7b"""
    m = (model or "").strip().lower()
    return m.split("/", 1)[1] if "/" in m else m


def custom_prices() -> dict[str, Price]:
    raw = _env("MODEL_PRICES")
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    out: dict[str, Price] = {}
    for name, p in (data or {}).items():
        try:
            out[model_key(name)] = Price(float(p.get("input", 0)), float(p.get("cached", p.get("input", 0))),
                                         float(p.get("output", 0)), 1.0, "自定义")
        except (AttributeError, TypeError, ValueError):
            continue
    return out


def price_for(model: str, custom: dict[str, Price] | None = None) -> Price | None:
    key = model_key(model)
    custom = custom_prices() if custom is None else custom
    if key in custom:
        return custom[key]
    if model.lower().startswith(("ollama/", "ollama_chat/")):
        return Price(0, 0, 0, 1.0, "本地模型", "本地运行，不计费")
    return BUILTIN.get(key)


def is_peak(ts_utc: str | datetime) -> bool:
    """DeepSeek 高峰时段：北京时间周一至周五 9–12 点、14–18 点"""
    if isinstance(ts_utc, str):
        try:
            t = datetime.fromisoformat(ts_utc.replace(" ", "T")).replace(tzinfo=timezone.utc)
        except ValueError:
            return False
    else:
        t = ts_utc if ts_utc.tzinfo else ts_utc.replace(tzinfo=timezone.utc)
    bj = t.astimezone(_BJ)
    return bj.weekday() < 5 and (9 <= bj.hour < 12 or 14 <= bj.hour < 18)


def call_cost(row: dict[str, Any], price: Price | None) -> float | None:
    """单次调用的费用（元）。没有价格时返回 None。"""
    if price is None:
        return None
    prompt = row.get("prompt_tokens") or 0
    cached = min(row.get("cached_tokens") or 0, prompt)
    out = row.get("completion_tokens") or 0
    mult = price.peak_multiplier if price.peak_multiplier != 1.0 and is_peak(row.get("ts") or "") else 1.0
    return ((prompt - cached) * price.input + cached * price.cached + out * price.output) * mult / 1_000_000


def price_table(models: list[str]) -> list[dict[str, Any]]:
    custom = custom_prices()
    rows = []
    for m in models:
        p = price_for(m, custom)
        rows.append({
            "model": m, "key": model_key(m), "known": p is not None,
            **({"input": p.input, "cached": p.cached, "output": p.output, "peak_multiplier": p.peak_multiplier,
                "source": p.source, "note": p.note} if p else {}),
        })
    return rows
