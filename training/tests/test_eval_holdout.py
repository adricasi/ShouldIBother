import json
from pathlib import Path
from typing import Any

import pytest
from helpers import FIXTURE_DATASET

from training import eval_holdout
from training.dataset import load_dataset

VALID = json.dumps({"status": "ok", "band": "likely", "reason": "dry night", "settle_in_hours": 12})


class FakeOllama:
    """The HTTP boundary: records each request body and answers from a script per mode.

    `constrained` answers requests that carry a `format`, `unconstrained` those that do not.
    """

    def __init__(
        self, unconstrained: list[Any] | None = None, constrained: list[Any] | None = None
    ) -> None:
        self.bodies: list[dict[str, Any]] = []
        self.scripts = {True: constrained or [], False: unconstrained or []}
        self.counts = {True: 0, False: 0}

    def __call__(self, body: dict[str, Any]) -> dict[str, Any]:
        self.bodies.append(body)
        mode = "format" in body
        index = self.counts[mode]
        self.counts[mode] += 1
        script = self.scripts[mode]
        answer = script[index] if index < len(script) else VALID
        if isinstance(answer, dict):
            return answer
        return {"message": {"role": "assistant", "content": answer}}


def run(*args: str, chat: FakeOllama | None = None) -> tuple[int, str, FakeOllama]:
    fake = chat or FakeOllama()
    lines: list[str] = []
    code = eval_holdout.main(
        ["--dataset", str(FIXTURE_DATASET), "--model", "sib-bookmaker-ft:v1", *args],
        chat=fake,
        echo=lines.append,
    )
    return code, "\n".join(lines), fake


def test_AC_019_2_all_valid_answers_pass_and_both_rates_are_reported() -> None:
    code, text, fake = run("--count", "5", "--min-valid", "5")
    assert code == 0
    assert "5/5 valid bookmaker answers without the schema" in text
    assert "schema-constrained: 5/5 valid" in text
    assert "unconstrained (the gate): 5/5 valid" in text
    assert "PASS" in text
    assert len(fake.bodies) == 10


def test_AC_019_2_the_default_is_twenty_prompts_and_nineteen_valid() -> None:
    # The fixture hold-out has 7 rows, so 20 cannot be drawn: that is reported, not faked.
    code, text, _ = run()
    assert code == eval_holdout.EXIT_BAD_INPUT
    assert "7 rows, 20 were asked for" in text
    assert (eval_holdout.DEFAULT_COUNT, eval_holdout.DEFAULT_MIN_VALID) == (20, 19)


def test_one_invalid_answer_is_tolerated_two_are_not() -> None:
    answers = ["not json at all"] + [VALID] * 6
    code, text, _ = run("--count", "7", "--min-valid", "6", chat=FakeOllama(answers))
    assert code == 0
    assert "6/7" in text
    assert "not valid JSON" in text

    answers = ["not json", '{"status": "ok"}'] + [VALID] * 5
    code, text, _ = run("--count", "7", "--min-valid", "6", chat=FakeOllama(answers))
    assert code == eval_holdout.EXIT_BELOW_TARGET
    assert "FAIL" in text
    assert "needs band, reason" in text


def test_AC_019_2_the_gate_is_the_unconstrained_rate_not_the_constrained_one() -> None:
    # Constrained decoding hides a model that cannot write the format: it must not pass the gate.
    broken = ["not json"] * 7
    code, text, _ = run("--count", "7", "--min-valid", "7", chat=FakeOllama(unconstrained=broken))
    assert code == eval_holdout.EXIT_BELOW_TARGET
    assert "schema-constrained: 7/7 valid" in text
    assert "unconstrained (the gate): 0/7 valid" in text
    assert "FAIL" in text
    # The reverse: a model that fails only when constrained still passes the gate.
    code, text, _ = run("--count", "7", "--min-valid", "7", chat=FakeOllama(constrained=broken))
    assert code == 0
    assert "schema-constrained: 0/7 valid" in text


def test_a_tool_call_instead_of_an_answer_is_invalid() -> None:
    called = {"message": {"content": VALID, "tool_calls": [{"function": {"name": "get_forecast"}}]}}
    _, text, _ = run("--count", "1", "--min-valid", "1", chat=FakeOllama([called]))
    assert "called a tool instead of answering" in text


def test_a_response_without_content_is_invalid() -> None:
    row = load_dataset(FIXTURE_DATASET).holdout[0]
    result = eval_holdout.evaluate_case(row, {"error": "model not found"})
    assert result.valid is False
    assert result.errors == ("the response has no message content",)


def test_the_request_mirrors_the_live_client() -> None:
    _, _, fake = run("--count", "1", "--min-valid", "1")
    body = fake.bodies[0]
    assert body["model"] == "sib-bookmaker-ft:v1"
    assert body["stream"] is False
    assert body["options"] == {"temperature": 0, "seed": 42}
    assert body["format"]["properties"]["band"]["enum"][0] == "very_unlikely"
    assert [m["role"] for m in body["messages"]] == ["system", "user", "assistant", "tool"]
    assert body["messages"][2]["tool_calls"] == [
        {"function": {"name": "get_forecast", "arguments": {"hours_ahead": 24}}}
    ]
    # Ollama names the tool of a result `tool_name`, as in src/server/model/ollama-wire.ts.
    assert body["messages"][3]["tool_name"] == "get_forecast"
    assert "name" not in body["messages"][3]
    assert body["tools"][0]["function"]["name"] == "get_forecast"


def test_one_pass_sends_the_schema_and_the_other_leaves_it_out() -> None:
    _, _, fake = run("--count", "1", "--min-valid", "1")
    assert sorted("format" in body for body in fake.bodies) == [False, True]
    constrained = next(body for body in fake.bodies if "format" in body)
    plain = next(body for body in fake.bodies if "format" not in body)
    assert {k: v for k, v in constrained.items() if k != "format"} == plain


def test_no_prompt_carries_an_answer_or_a_target() -> None:
    _, _, fake = run("--count", "7", "--min-valid", "0")
    for body in fake.bodies:
        assert body["messages"][-1]["role"] == "tool"
        assert "target" not in json.dumps(body)


def test_NFR_012_the_same_seed_picks_the_same_prompts() -> None:
    rows = load_dataset(FIXTURE_DATASET).holdout
    first = [r.id for r in eval_holdout.select_prompts(rows, 4, 42)]
    assert first == [r.id for r in eval_holdout.select_prompts(rows, 4, 42)]
    assert first != [r.id for r in eval_holdout.select_prompts(rows, 4, 43)]
    assert len(set(first)) == 4


def test_a_report_file_is_written_as_json(tmp_path: Path) -> None:
    path = tmp_path / "report.json"
    code, _, _ = run("--count", "3", "--min-valid", "3", "--report", str(path))
    assert code == 0
    report = json.loads(path.read_text())
    assert report["model"] == "sib-bookmaker-ft:v1"
    assert report["manifest_sha256"] == load_dataset(FIXTURE_DATASET).manifest_sha256
    assert report["unconstrained"]["valid"] == 3
    assert report["constrained"]["valid"] == 3
    assert report["unconstrained"]["bands"] == {"likely": 3}


def test_a_non_loopback_address_is_refused() -> None:
    lines: list[str] = []
    code = eval_holdout.main(
        [
            "--dataset",
            str(FIXTURE_DATASET),
            "--model",
            "m",
            "--base-url",
            "http://example.com:11434",
        ],
        echo=lines.append,
    )
    assert code == eval_holdout.EXIT_BAD_INPUT
    assert "loopback" in lines[0]


@pytest.mark.parametrize("args", [["--count", "0"], ["--count", "3", "--min-valid", "4"]])
def test_bad_counts_are_refused(args: list[str]) -> None:
    code, text, _ = run(*args)
    assert code == eval_holdout.EXIT_BAD_INPUT
    assert "--count" in text


def test_the_model_defaults_to_the_configured_tag() -> None:
    fake = FakeOllama()
    lines: list[str] = []
    eval_holdout.main(
        ["--dataset", str(FIXTURE_DATASET), "--count", "1", "--min-valid", "1"],
        chat=fake,
        echo=lines.append,
    )
    assert fake.bodies[0]["model"] == "sib-bookmaker-ft:v1"
