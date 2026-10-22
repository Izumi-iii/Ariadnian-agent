"""Regression coverage for recommend -> insert -> verify and repeated reviews."""
from __future__ import annotations

import dataclasses
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-citations-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app import assist, library
from app.library import Paper
from app.retrieval import Hit


@pytest.fixture
def paper(monkeypatch):
    p = Paper(id="consistency-paper", bibkey="evidence2024", title="Evidence Paper", year=2024)
    monkeypatch.setattr(library, "list_papers", lambda: [p])
    monkeypatch.setattr(assist, "get_paper", lambda pid: p if pid == p.id else None)
    assist._cached_support.cache_clear()
    yield p
    assist._cached_support.cache_clear()


def test_missing_claim_is_promoted_to_full_sentence_before_judging(monkeypatch, paper):
    fragment = "检索增强生成可以改善回答质量"
    whole = f"在限定的实验中，{fragment}，但不保证所有任务都适用。"
    seen = []
    monkeypatch.setattr(assist, "_review", lambda *args: {"missing": [{"sentence": fragment}]})
    monkeypatch.setattr(assist, "suggest_citations", lambda sentence, **kwargs: seen.append(sentence) or [])
    result = assist.annotate(whole, check_citations=False)
    assert [a["anchor"] for a in result] == [whole]
    assert seen == [whole]


@pytest.mark.parametrize("after_punctuation", [False, True])
def test_review_cannot_report_a_cited_sentence_or_its_fragment_as_missing(monkeypatch, paper, after_punctuation):
    fragment = "检索增强生成可以改善回答质量"
    whole = f"已有研究表明，{fragment}，但这种效果受到任务条件和证据质量限制。"
    paragraph = whole + f"[@{paper.bibkey}]" if after_punctuation else whole[:-1] + f"[@{paper.bibkey}]。"
    monkeypatch.setattr(assist, "_review", lambda *args: {"missing": [{"sentence": fragment}, {"sentence": whole}]})
    monkeypatch.setattr(assist, "suggest_citations", lambda *args, **kwargs: pytest.fail("cited sentence was recommended again"))
    assert assist.annotate(paragraph, check_citations=False) == []


def test_duplicate_model_claims_produce_only_one_missing_annotation(monkeypatch, paper):
    whole = "检索增强生成可以改善回答质量，但其效果取决于检索内容是否与问题相关。"
    monkeypatch.setattr(assist, "_review", lambda *args: {"missing": [{"sentence": whole}, {"sentence": whole[:15]}]})
    seen = []
    monkeypatch.setattr(assist, "suggest_citations", lambda sentence, **kwargs: seen.append(sentence) or [])
    assert len(assist.annotate(whole, check_citations=False)) == 1
    assert seen == [whole]


def test_ambiguous_identical_sentences_are_not_attached_to_the_wrong_occurrence(monkeypatch, paper):
    whole = "检索增强生成可以改善回答质量，但这种改善取决于检索证据的相关性。"
    monkeypatch.setattr(assist, "_review", lambda *args: {"missing": [{"sentence": whole}]})
    monkeypatch.setattr(assist, "suggest_citations", lambda *args, **kwargs: pytest.fail("ambiguous occurrence"))
    assert assist.annotate(whole + whole, check_citations=False) == []


def test_recommendation_and_verification_use_identical_evidence_and_cached_verdict(monkeypatch, paper):
    sentence = "Retrieval evidence improves answer quality under specified conditions."
    global_hit = Hit(1, paper.id, "A globally ranked but incomplete passage.", None, 1, 1)
    scoped_hit = Hit(2, paper.id, "The actual passage selected within this paper.", "Results", 3, 1)
    monkeypatch.setattr(assist, "search", lambda query, top_k, paper_ids=None: [scoped_hit] if paper_ids else [global_hit])
    calls = []
    def judge(messages, **kwargs):
        calls.append(messages)
        return {"verdict": "supports" if len(calls) == 1 else "partial", "reason": "test"}
    monkeypatch.setattr(assist.llm, "chat_json", judge)
    recommended = assist.suggest_citations(sentence)[0]
    verified = assist.verify_citation(sentence, paper.id)
    assert recommended["verdict"] == verified["verdict"] == "supports"
    assert recommended["snippet"] == verified["snippet"] == scoped_hit.text
    assert recommended["page"] == verified["page"] == 3
    assert len(calls) == 1
    assert scoped_hit.text in calls[0][1]["content"]
    assert global_hit.text not in calls[0][1]["content"]


def test_judgment_cache_changes_with_evidence_and_model_and_returns_copies(monkeypatch, paper):
    calls = []
    monkeypatch.setattr(assist.llm, "chat_json", lambda *args, **kwargs: calls.append(1) or {"verdict": "supports"})
    first = assist.judge_support("A claim.", paper, "First evidence.")
    first["verdict"] = "unrelated"
    assert assist.judge_support("A claim.", paper, "First evidence.")["verdict"] == "supports"
    assist.judge_support("A claim.", paper, "Changed evidence.")
    original = assist.get_settings()
    changed = dataclasses.replace(original, tiers={**original.tiers, "judge": dataclasses.replace(original.tiers["judge"], model="openai/other-model")})
    monkeypatch.setattr(assist, "get_settings", lambda: changed)
    assist.judge_support("A claim.", paper, "Changed evidence.")
    assert len(calls) == 3


def test_insert_then_review_does_not_repeat_missing_or_reverse_the_same_judgment(monkeypatch, paper):
    whole = "Retrieval evidence can improve answer quality under specific evaluation conditions."
    fragment = "Retrieval evidence can improve answer quality"
    hit = Hit(1, paper.id, "Evidence for the claim under specific conditions.", "Results", 2, 1)
    monkeypatch.setattr(assist, "search", lambda *args, **kwargs: [hit])
    # Even a model that keeps reporting the same fragment cannot create a loop.
    monkeypatch.setattr(assist, "_review", lambda *args: {"missing": [{"sentence": fragment}]})
    calls = []
    def judge(*args, **kwargs):
        calls.append(1)
        return {"verdict": "supports" if len(calls) == 1 else "partial"}
    monkeypatch.setattr(assist.llm, "chat_json", judge)
    before = assist.annotate(whole)
    assert before[0]["anchor"] == whole
    assert before[0]["candidates"][0]["verdict"] == "supports"
    after = assist.annotate(whole[:-1] + f"[@{paper.bibkey}].")
    assert [item["kind"] for item in after] == ["cite_check"]
    assert after[0]["items"][0]["verdict"] == "supports"
    assert len(calls) == 1


def test_transient_judgment_failure_is_not_cached(monkeypatch, paper):
    calls = []
    def judge(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("temporary failure")
        return {"verdict": "supports"}
    monkeypatch.setattr(assist.llm, "chat_json", judge)
    assert assist.judge_support("A claim.", paper, "Evidence.")["verdict"] == "unknown"
    assert assist.judge_support("A claim.", paper, "Evidence.")["verdict"] == "supports"
    assert len(calls) == 2


def test_no_or_foreign_evidence_is_unknown_rather_than_unsupported(monkeypatch, paper):
    for hits in ([], [Hit(9, "other-paper", "Wrong paper.", None, 1, 1)]):
        monkeypatch.setattr(assist, "search", lambda *args, **kwargs: hits)
        assert assist.verify_citation("An English claim.", paper.id)["verdict"] == "unknown"


@pytest.mark.parametrize("fragment_only", [False, True])
def test_style_rewrite_is_rejected_when_its_sentence_already_has_a_citation(monkeypatch, paper, fragment_only):
    whole = "这种方法在很大程度上改善了实验任务的回答质量，但其效果仍取决于证据是否相关。"
    original = "在很大程度上改善了实验任务的回答质量" if fragment_only else whole
    monkeypatch.setattr(assist, "_review", lambda *args: {"rewrite": {"sentence": original, "revised": "改善了回答质量。"}})
    annotations = assist.annotate(whole[:-1] + f"[@{paper.bibkey}]。", check_citations=False)
    assert not any(annotation["kind"] == "rewrite" for annotation in annotations)
