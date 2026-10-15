"""测评脚本的冒烟测试：不联网、不需要 API key，只保证测评流程本身能跑通、指标算得对。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent

# 子进程里 mock 掉 litellm.completion，走“真实模型”分支（关键词扩展、延迟统计、调用日志）
_MOCK = r'''
import json, sys, types, litellm
def completion(**kw):
    system = kw["messages"][0]["content"]
    user = kw["messages"][-1]["content"]
    if "判断给定的文献片段" in system:
        text = json.dumps({"verdict": "supports" if "neural" in user.lower() or "retriev" in user.lower() else "unrelated", "reason": "mock"})
    elif "英文学术检索关键词" in system:
        text = "retrieval augmented generation dense passage residual transformer attention"
    elif "审稿人" in system:
        first = user.split("段落（[引用] 表示该处已有引用）：\n", 1)[1].split("。", 1)[0] + "。"
        text = json.dumps({"missing": [{"sentence": first, "reason": "mock"}], "rewrite": None}, ensure_ascii=False)
    else:
        text = "这是续写。"
    msg = types.SimpleNamespace(content=text)
    usage = types.SimpleNamespace(prompt_tokens=100, completion_tokens=10)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)], usage=usage)
litellm.completion = completion
from evals.__main__ import main
sys.exit(main(sys.argv[1:]))
'''


def _run(args: list[str], code: str | None = None, tmp_path: Path | None = None) -> tuple[int, str]:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    if tmp_path is not None:
        env["ARIA_DATA_DIR"] = str(tmp_path)
    env.pop("LLM_FAKE", None)
    cmd = [sys.executable, "-c", code, *args] if code else [sys.executable, "-m", "evals", *args]
    p = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, text=True, encoding="utf-8", timeout=300)
    return p.returncode, p.stdout + p.stderr


def test_eval_offline_fixture(tmp_path):
    code, out = _run(["--offline", "--source", "fixture", "--no-save"], tmp_path=tmp_path)
    assert code == 0, out
    assert "引用判断  n=6" in out
    assert "假引用检出" in out and "检索（语料 6 段）" in out and "缺引用检测" in out


def test_eval_model_path_with_mocked_litellm(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({"LLM_API_KEY": "sk-test"}), encoding="utf-8")
    code, out = _run(["--source", "fixture", "--model", "openai/mock", "--no-save", "--workers", "2"], code=_MOCK, tmp_path=tmp_path)
    assert code == 0, out
    assert "真实模型" in out
    assert "zh_bm25_expand" in out          # 有模型时才会跑跨语言扩展
    assert "行内续写  P50" in out
    assert "模型调用" in out


def test_metrics():
    sys.path.insert(0, str(BACKEND))
    from evals.metrics import pct, prf, ranking_metrics

    assert prf(2, 1, 1) == {"precision": 0.667, "recall": 0.667, "f1": 0.667, "tp": 2, "fp": 1, "fn": 1}
    m = ranking_metrics([(["a", "b"], {"b"}), (["c"], {"x"})])
    assert m["recall@1"] == 0.0 and m["recall@5"] == 0.5 and m["mrr@10"] == 0.25
    assert pct([10, 20, 30, 40], 50) == 20 and pct([10, 20, 30, 40], 95) == 40
