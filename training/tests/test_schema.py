import json
from typing import Any

import pytest

from training.schema import ANSWER_JSON_SCHEMA, BAND_NAMES, answer_errors, parse_answer

OK: dict[str, Any] = {
    "status": "ok",
    "band": "likely",
    "reason": "dry night, so the pots will be fine",
    "settle_in_hours": 13,
}


def test_a_complete_ok_answer_is_valid() -> None:
    assert answer_errors(OK) == []
    assert answer_errors({**OK, "disagreement_reason": "In 20 of 30 similar days it worked."}) == []


def test_an_unsure_answer_needs_a_question() -> None:
    assert answer_errors({"status": "unsure", "question": "Is the washing out already?"}) == []
    assert answer_errors({"status": "unsure"}) == ['status "unsure" needs a yes/no question']


@pytest.mark.parametrize(
    ("answer", "fragment"),
    [
        ({**OK, "band": "certain"}, "band must be one of"),
        ({**OK, "status": "maybe"}, "status must be"),
        ({k: v for k, v in OK.items() if k != "band"}, "needs band, reason"),
        ({k: v for k, v in OK.items() if k != "settle_in_hours"}, "needs band, reason"),
        ({**OK, "reason": "   "}, "needs band, reason"),
        ({**OK, "reason": "x" * 141}, "reason must be a string of at most 140"),
        ({**OK, "settle_in_hours": 241}, "settle_in_hours must be a number"),
        ({**OK, "settle_in_hours": -1}, "settle_in_hours must be a number"),
        ({**OK, "settle_in_hours": True}, "settle_in_hours must be a number"),
        ({**OK, "odds": 85}, "unknown key 'odds'"),
        ({**OK, "disagreement_reason": "x" * 201}, "disagreement_reason must be"),
    ],
)
def test_broken_answers_are_reported(answer: dict[str, Any], fragment: str) -> None:
    assert any(fragment in error for error in answer_errors(answer))


def test_an_answer_that_is_not_an_object_is_invalid() -> None:
    assert answer_errors([OK]) == ["the answer is not a JSON object"]


def test_parse_answer_reports_bad_json() -> None:
    answer, errors = parse_answer("{not json")
    assert answer is None
    assert errors[0].startswith("not valid JSON")
    answer, errors = parse_answer(json.dumps(OK))
    assert answer == OK
    assert errors == []
    assert parse_answer("[1]") == (None, ["the answer is not a JSON object"])


def test_the_json_schema_lists_the_five_bands() -> None:
    assert ANSWER_JSON_SCHEMA["properties"]["band"]["enum"] == list(BAND_NAMES)
    assert ANSWER_JSON_SCHEMA["additionalProperties"] is False
