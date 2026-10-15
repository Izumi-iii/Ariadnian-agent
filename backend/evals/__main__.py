"""运行测评：  uv run python -m evals [--tasks judge,fake_cite] [--limit 50] [--model deepseek/deepseek-chat] [--offline]

（仓库根目录下也可以用 npm run eval -- <同样的参数>）

- 使用网页「设置」或 .env 里配置的模型；--model 可临时把所有档位换成同一个模型做对比。
- 测评在一个临时数据目录里进行（复制一份设置），不会碰你的文献库和论文。
- 结果写入 evals/results/<时间>_<模型>.json，并重新生成 evals/results/README.md 汇总表。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
RESULTS = HERE / "results"


def _prepare_env(args: argparse.Namespace) -> Path:
    """在 import app 之前切到临时数据目录，并带上用户的设置（模型、Key）。"""
    real = Path(os.getenv("ARIA_DATA_DIR") or (BACKEND / "data"))
    tmp = Path(tempfile.mkdtemp(prefix="aria-eval-"))
    settings: dict[str, str] = {}
    if (real / "settings.json").exists():
        settings = json.loads((real / "settings.json").read_text(encoding="utf-8"))
    if args.model:
        settings.update({"MODEL_ID": args.model, "FAST_MODEL_ID": args.model,
                         **{f"MODEL_{t}": args.model for t in ("COMPLETE", "WRITE", "JUDGE", "AGENT")}})
    # 网页里开着“离线演示模式”时，真实测评也要调用模型，所以显式关掉
    settings["LLM_FAKE"] = "1" if args.offline else "__none__"
    (tmp / "settings.json").write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
    os.environ["ARIA_DATA_DIR"] = str(tmp)
    if args.offline:
        os.environ["LLM_FAKE"] = "1"
    return tmp


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m evals", description="Ariadne 测评")
    ap.add_argument("--tasks", default="judge,fake_cite,retrieval,missing,latency", help="逗号分隔")
    ap.add_argument("--limit", type=int, default=None, help="每个任务最多取多少条（默认全部）")
    ap.add_argument("--workers", type=int, default=4, help="并发调用模型的线程数")
    ap.add_argument("--model", default=None, help="临时把所有档位换成这个模型，如 deepseek/deepseek-chat")
    ap.add_argument("--offline", action="store_true", help="不调用模型：用离线规则作为基线")
    ap.add_argument("--source", default="scifact", choices=["scifact", "fixture"], help="fixture=内置几条样例，不联网")
    ap.add_argument("--label", default=None, help="结果文件名里的标签")
    ap.add_argument("--no-save", action="store_true", help="只打印，不写结果文件")
    args = ap.parse_args(argv)

    tmp = _prepare_env(args)
    sys.path.insert(0, str(BACKEND))
    from app.config import get_settings
    from app.db import init_db

    from . import report, tasks
    from .datasets import load

    names = tasks.iter_tasks(x.strip() for x in args.tasks.split(",") if x.strip())
    s = get_settings()
    if not s.llm_ready:
        print("✗ 没有配置模型 API Key。请先在网页「设置」里配置，或加 --offline 只跑离线基线。", file=sys.stderr)
        return 2
    init_db()
    models = {t: tier.model for t, tier in s.tiers.items()}
    mode = "offline" if s.llm_fake else "model"
    print(f"▸ 模式：{'离线基线（不调用模型）' if s.llm_fake else '真实模型'}  judge={models['judge']}  complete={models['complete']}", file=sys.stderr)

    t0 = time.perf_counter()
    bundle = load(args.source)
    print(f"▸ 数据：{len(bundle.pairs)} 对论断—证据，{len(bundle.passages)} 段检索语料", file=sys.stderr)
    lib = None
    out: dict = {}
    try:
        for name in names:
            print(f"▸ {name}", file=sys.stderr)
            ts = time.perf_counter()
            if name in ("fake_cite", "retrieval") and lib is None:
                lib = tasks.Library(bundle)
            if name == "judge":
                out[name] = tasks.run_judge(bundle, args.limit, args.workers)
            elif name == "fake_cite":
                out[name] = tasks.run_fake_cite(bundle, lib, args.limit, args.workers)
            elif name == "retrieval":
                out[name] = tasks.run_retrieval(bundle, lib, args.limit, s.llm_fake)
            elif name == "missing":
                out[name] = tasks.run_missing(bundle, args.limit, args.workers)
            elif name == "latency":
                out[name] = tasks.run_latency(bundle, args.limit) if not s.llm_fake else {"skipped": "离线模式不测延迟"}
            out[name]["seconds"] = round(time.perf_counter() - ts, 1)
        usage = tasks.llm_usage()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    result = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "mode": mode,
        "models": models,
        "embeddings": f"{s.embedding_provider}/{s.embedding_model}" if s.embedding_provider != "none" else None,
        "source": args.source,
        "limit": args.limit,
        "data": {"pairs": len(bundle.pairs), "corpus": len(bundle.passages),
                 "zh_claims": len(bundle.zh_claims), "citeworthy_paragraphs": len(bundle.citeworthy)},
        "tasks": out,
        "llm_usage": usage,
        "seconds": round(time.perf_counter() - t0, 1),
    }
    print(report.summarize(result))
    if not args.no_save:
        RESULTS.mkdir(exist_ok=True)
        label = args.label or ("offline" if s.llm_fake else models["judge"])
        slug = re.sub(r"[^\w.-]+", "-", label).strip("-")[:60]
        path = RESULTS / f"{datetime.now():%Y%m%d-%H%M}_{slug}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        report.write_index(RESULTS)
        print(f"\n✓ 已保存 {path.relative_to(BACKEND)}，汇总表：evals/results/README.md", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
