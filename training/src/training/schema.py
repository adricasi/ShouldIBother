"""The bookmaker answer schema, mirrored from `bookmakerOutputSchema` in
`src/server/gemma/bookmaker.ts` (the TypeScript side is the source of truth).

Used to check that every training target is a valid answer (the dataset builder already ran the
live job on it) and to score the fine-tuned model on the hold-out prompts (AC-019.2).
"""

from __future__ import annotations

import json
from typing import Any

BAND_NAMES = ("very_unlikely", "unlikely", "toss_up", "likely", "very_likely")
MAX_REASON_CHARS = 140
MAX_TEXT_CHARS = 200
MAX_SETTLE_HOURS = 240
ANSWER_KEYS = frozenset(
    {"status", "band", "reason", "settle_in_hours", "disagreement_reason", "question"}
)

# The flat JSON schema sent to the runtime as `format`; the cross-field rules are checked after.
ANSWER_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["ok", "unsure"]},
        "band": {"type": "string", "enum": list(BAND_NAMES)},
        "reason": {"type": "string", "maxLength": MAX_REASON_CHARS},
        "settle_in_hours": {"type": "number", "minimum": 0, "maximum": MAX_SETTLE_HOURS},
        "disagreement_reason": {"type": "string", "maxLength": MAX_TEXT_CHARS},
        "question": {"type": "string", "maxLength": MAX_TEXT_CHARS},
    },
    "required": ["status"],
    "additionalProperties": False,
}


def answer_errors(answer: Any) -> list[str]:
    """Every way `answer` (a parsed JSON value) breaks the bookmaker schema; empty when valid."""
    if not isinstance(answer, dict):
        return ["the answer is not a JSON object"]
    errors = [f"unknown key {key!r}" for key in sorted(set(answer) - ANSWER_KEYS)]

    status = answer.get("status")
    if status not in ("ok", "unsure"):
        errors.append('status must be "ok" or "unsure"')
    band = answer.get("band")
    if band is not None and band not in BAND_NAMES:
        errors.append(f"band must be one of {', '.join(BAND_NAMES)}")
    for key, limit in (
        ("reason", MAX_REASON_CHARS),
        ("disagreement_reason", MAX_TEXT_CHARS),
        ("question", MAX_TEXT_CHARS),
    ):
        text = answer.get(key)
        if text is not None and (not isinstance(text, str) or len(text) > limit):
            errors.append(f"{key} must be a string of at most {limit} characters")
    hours = answer.get("settle_in_hours")
    if hours is not None and (
        isinstance(hours, bool)
        or not isinstance(hours, int | float)
        or not 0 <= hours <= MAX_SETTLE_HOURS
    ):
        errors.append(f"settle_in_hours must be a number from 0 to {MAX_SETTLE_HOURS}")

    if status == "ok":
        reason = answer.get("reason")
        if band is None or not isinstance(reason, str) or not reason.strip() or hours is None:
            errors.append('status "ok" needs band, reason and settle_in_hours')
    if status == "unsure":
        question = answer.get("question")
        if not isinstance(question, str) or not question.strip():
            errors.append('status "unsure" needs a yes/no question')
    return errors


def parse_answer(text: str) -> tuple[dict[str, Any] | None, list[str]]:
    """Parses answer text; returns (answer, []) when valid, else (None-or-answer, errors)."""
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        return None, [f"not valid JSON: {error.msg}"]
    errors = answer_errors(value)
    return (value if isinstance(value, dict) else None), errors
