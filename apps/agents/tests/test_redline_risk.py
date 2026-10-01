"""Tests for the deterministic half of negotiation risk scoring.

The model rates each wording (our standard, their proposal, our counter) on
deviation, exposure and market, and the clause's event once on likelihood.
The score itself is computed in redline_agent.py, so the same ratings always
give the same number. These tests pin that half: the formula, the clamping of
the model's ratings, the counter staying between our wording and theirs, the
text the redline panel shows, and the merge of step 2's scores onto step 1's
changes.

Run:  cd apps/agents && python -m pytest tests/test_redline_risk.py -q
"""
from __future__ import annotations

from app.agents.redline_agent import (
    _factors,
    _merge_scores,
    _risk_score,
    _risk_summary,
    _with_risk_text,
)

OURS = {"deviation": 0, "exposure": 1, "market": 0}
THEIRS = {"deviation": 3, "exposure": 4, "market": 2}


def change(**extra) -> dict:
    return {"changeId": "c1", "likelihood": 3, "ourAssessment": OURS, "theirAssessment": THEIRS,
            "riskReason": "They removed the cap.", **extra}


# ── The formula ─────────────────────────────────────────────────────────────

def test_score_runs_from_0_to_100():
    assert _risk_score({"deviation": 0, "exposure": 0, "likelihood": 1, "market": 0}) == 0
    assert _risk_score({"deviation": 3, "exposure": 4, "likelihood": 3, "market": 3}) == 100


def test_score_weights_deviation_exposure_and_market():
    # 100 × (0.45 × 2/3 + 0.35 × 2×2/12 + 0.20 × 1/3) = 30 + 11.7 + 6.7
    assert _risk_score({"deviation": 2, "exposure": 2, "likelihood": 2, "market": 1}) == 48


# ── The model's ratings ─────────────────────────────────────────────────────

def test_missing_ratings_give_no_score():
    assert _risk_score(None) is None
    assert _factors(None) is None
    assert _factors({"deviation": 1, "exposure": 2}, likelihood=2) is None
    assert _factors({"deviation": "high", "exposure": 2, "market": 1}, likelihood=2) is None


def test_ratings_are_clamped_to_their_ranges():
    assert _factors({"deviation": 7, "exposure": -2, "market": "2"}, likelihood=9) == \
        {"deviation": 3, "exposure": 0, "likelihood": 3, "market": 2}
    assert _factors({"deviation": 1, "exposure": 1, "market": 1}, likelihood=0)["likelihood"] == 1


def test_likelihood_is_rated_once_per_change():
    # Wording changes what we could lose, not whether the event happens, so a
    # likelihood the model put on one wording gives way to the change's rating.
    assert _factors({**OURS, "likelihood": 3}, likelihood=1)["likelihood"] == 1


# ── What the redline panel shows ────────────────────────────────────────────

def test_reasoning_shows_the_move_and_why():
    out = _with_risk_text(change())
    assert (out["riskBefore"], out["riskAfter"], out["riskDelta"]) == (9, 93, 84)
    assert out["reasoning"] == ("Risk 9 → 93 (+84): beyond our walkaway position; severe exposure, "
                                "likely; clearly off-market. They removed the cap.")


def test_counter_note_shows_the_revised_risk():
    out = _with_risk_text(change(counterText="Cap at 100% of fees.", counterNote="Meets them halfway.",
                                 counterAssessment={"deviation": 1, "exposure": 2, "market": 1}))
    assert out["riskRevised"] == 39
    assert out["counterNote"] == ("Revised risk if they accept: 39 (from 93, -54): within our acceptable "
                                  "position; moderate exposure, likely; slightly off-market. "
                                  "Meets them halfway.")


def test_a_counter_never_scores_worse_than_their_text():
    out = _with_risk_text(change(counterText="x", counterAssessment={"deviation": 3, "exposure": 4, "market": 3}))
    assert out["riskRevised"] == out["riskAfter"] == 93
    assert out["counterAssessment"] == out["theirAssessment"]


def test_a_counter_never_scores_better_than_our_standard():
    out = _with_risk_text(change(counterText="x", counterAssessment={"deviation": 0, "exposure": 0, "market": 0}))
    assert out["riskRevised"] == out["riskBefore"] == 9
    assert out["counterAssessment"] == out["ourAssessment"]


def test_a_change_without_ratings_keeps_its_text():
    out = _with_risk_text({"changeId": "c1", "reasoning": "Standard wording.",
                           "counterText": "x", "counterNote": "Why."})
    assert out["reasoning"] == "Standard wording."
    assert out["counterNote"] == "Why."
    assert out["riskBefore"] is None and out["riskAfter"] is None and "riskDelta" not in out


def test_summary_averages_with_our_counters_where_we_made_one():
    rows = [
        {"riskBefore": 10, "riskAfter": 90, "riskRevised": 40},
        {"riskBefore": 0, "riskAfter": 20, "riskRevised": None},   # accepted as proposed
        {"riskBefore": None, "riskAfter": None},                   # unscored, left out
    ]
    assert _risk_summary(rows) == (" Average risk across the 2 changed clauses: 5 in our standard, "
                                   "55 as proposed, 30 with our counter-proposals.")
    assert _risk_summary([{"riskBefore": None}]) == ""


# ── Merging step 2's scores onto step 1's changes ───────────────────────────

def test_scores_merge_by_change_id_and_keep_the_extracted_text():
    changes = [{"changeId": "a", "ourText": "A0", "theirText": "A1"},
               {"changeId": "b", "ourText": "B0", "theirText": "B1"}]
    parsed = [{"changeId": "b", "recommendation": "reject", "theirText": "(echoed)", "likelihood": 2},
              {"changeId": "a", "recommendation": "Accept with note"}]
    out = _merge_scores(changes, parsed)
    assert [c["recommendation"] for c in out] == ["accept", "reject"]
    assert out[1]["theirText"] == "B1"
    assert out[1]["likelihood"] == 2


def test_scores_without_ids_match_by_position_only_when_the_counts_agree():
    changes = [{"changeId": "a"}, {"changeId": "b"}]
    out = _merge_scores(changes, [{"recommendation": "counter"}, {"recommendation": "accept"}])
    assert [c["recommendation"] for c in out] == ["counter", "accept"]
    out = _merge_scores(changes, [{"recommendation": "accept"}])
    assert [c["recommendation"] for c in out] == ["counter", "counter"]
    assert _merge_scores(changes, "not json")[0]["recommendation"] == "counter"


# docs/41 P0.5 — with no playbook position, nothing is said about the market.
def test_without_playbook_claims_no_market_and_asks_a_person():
    from app.agents.redline_agent import without_playbook, _with_risk_text
    change = {
        "playbookAlignment": "acceptable", "likelihood": 2,
        "ourAssessment": {"deviation": 0, "exposure": 1, "market": 0},
        "theirAssessment": {"deviation": 2, "exposure": 3, "market": 2},
    }
    out = without_playbook(change)
    assert out["playbookAlignment"] == "not_covered" and out["requiresHumanReview"] is True
    assert out["theirAssessment"]["market"] == 0
    text = _with_risk_text(out, market=False)["reasoning"]
    assert "market" not in text.lower()
