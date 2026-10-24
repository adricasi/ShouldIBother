"""Does the fine-tuned model answer the bookmaker schema? (REQ-019 AC-019.2; T-012 Done-when.)

    PYTHONPATH=src uv run python -m training.eval_holdout --dataset <dir> --model <ollama tag>

Sends 20 hold-out prompts (the conversation up to the `get_forecast` result) to the local Ollama
and counts the answers that are valid JSON for the bookmaker schema. The goal is at least 19 of
20. This is the smoke test of the import, not the evaluation of the model: calibration and Brier
score on the whole hold-out are T-014 (`sib backtest`). Ollama is reached on 127.0.0.1 only.

The request follows the live client (`src/server/model/ollama-wire.ts`), which is UNVERIFIED
against a real Ollama until the builder runs this.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from training.config import ConfigError, load_config
from training.dataset import Dataset, DatasetError, Row, load_dataset
from training.ollama import DEFAULT_BASE_URL, ChatCall, OllamaError, make_chat_call
from training.provenance import write_json
from training.schema import ANSWER_JSON_SCHEMA, parse_answer

DEFAULT_COUNT = 20
DEFAULT_MIN_VALID = 19
DEFAULT_SEED = 42

EXIT_OK = 0
EXIT_BELOW_TARGET = 1
EXIT_BAD_INPUT = 2


@dataclass(frozen=True)
class CaseResult:
    id: str
    valid: bool
    errors: tuple[str, ...]
    band: str | None
    answer_chars: int


@dataclass(frozen=True)
class EvalReport:
    model: str
    prompt_version: str
    manifest_sha256: str
    seed: int
    constrained: bool
    asked: int
    valid: int
    min_valid: int
    bands: dict[str, int]
    failures: tuple[CaseResult, ...]

    @property
    def passed(self) -> bool:
        return self.valid >= self.min_valid


def select_prompts(rows: Sequence[Row], count: int, seed: int) -> list[Row]:
    """A fixed pseudo-random sample: same dataset, seed and count give the same rows (NFR-012)."""

    def key(row: Row) -> str:
        return hashlib.sha256(f"{seed}|{row.id}".encode()).hexdigest()

    return sorted(rows, key=key)[:count]


def to_wire_messages(row: Row) -> list[dict[str, Any]]:
    """The row's messages as Ollama's chat endpoint takes them (tool results by `tool_name`)."""
    wire: list[dict[str, Any]] = []
    for message in row.messages:
        item: dict[str, Any] = {"role": message["role"], "content": message["content"]}
        if "tool_calls" in message:
            item["tool_calls"] = [
                {
                    "function": {
                        "name": c["function"]["name"],
                        "arguments": c["function"]["arguments"],
                    }
                }
                for c in message["tool_calls"]
            ]
        if message["role"] == "tool":
            item["tool_name"] = message["name"]
        wire.append(item)
    return wire


def chat_body(row: Row, model: str, seed: int, *, constrained: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": to_wire_messages(row),
        "tools": [{"type": "function", "function": dict(tool["function"])} for tool in row.tools],
        "stream": False,
        "options": {"temperature": 0, "seed": seed},
    }
    if constrained:
        # The live bookmaker constrains the answer to the schema; --unconstrained asks without.
        body["format"] = ANSWER_JSON_SCHEMA
    return body


def evaluate_case(row: Row, response: dict[str, Any]) -> CaseResult:
    message = response.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str):
        return CaseResult(row.id, False, ("the response has no message content",), None, 0)
    answer, errors = parse_answer(content)
    if not errors and isinstance(message, dict) and message.get("tool_calls"):
        errors = ["the model called a tool instead of answering"]
    band = answer.get("band") if answer is not None else None
    return CaseResult(row.id, not errors, tuple(errors), band, len(content))


def run_eval(
    dataset: Dataset,
    chat: ChatCall,
    model: str,
    *,
    count: int = DEFAULT_COUNT,
    min_valid: int = DEFAULT_MIN_VALID,
    seed: int = DEFAULT_SEED,
    constrained: bool = True,
) -> EvalReport:
    rows = select_prompts(dataset.holdout, count, seed)
    if len(rows) < count:
        raise DatasetError(f"the hold-out has {len(rows)} rows, {count} were asked for")
    results = [
        evaluate_case(row, chat(chat_body(row, model, seed, constrained=constrained)))
        for row in rows
    ]
    bands = Counter(result.band for result in results if result.valid and result.band)
    return EvalReport(
        model=model,
        prompt_version=dataset.prompt_version,
        manifest_sha256=dataset.manifest_sha256,
        seed=seed,
        constrained=constrained,
        asked=len(results),
        valid=sum(result.valid for result in results),
        min_valid=min_valid,
        bands=dict(sorted(bands.items())),
        failures=tuple(result for result in results if not result.valid),
    )


def format_report(report: EvalReport) -> str:
    lines = [
        f"{report.model}: {report.valid}/{report.asked} valid bookmaker answers "
        f"(need {report.min_valid}) - {'PASS' if report.passed else 'FAIL'}",
        f"  prompt {report.prompt_version}, seed {report.seed}, "
        f"{'schema-constrained' if report.constrained else 'unconstrained'}",
        f"  bands answered: {report.bands or 'none'}",
    ]
    for failure in report.failures:
        lines.append(f"  invalid {failure.id}: {'; '.join(failure.errors)}")
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.eval_holdout",
        description="Check the fine-tuned model answers the bookmaker schema on hold-out prompts.",
    )
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", help="the Ollama tag; defaults to export.ollama_tag")
    parser.add_argument("--config", type=Path, help="config to take the default tag from")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--min-valid", type=int, default=DEFAULT_MIN_VALID)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--unconstrained", action="store_true", help="do not send the JSON schema as `format`"
    )
    parser.add_argument("--report", type=Path, help="also write the report here as JSON")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    chat: ChatCall | None = None,
    echo: Callable[[str], None] = print,
) -> int:
    args = _parser().parse_args(list(sys.argv[1:] if argv is None else argv))
    try:
        if args.count < 1 or args.min_valid < 0 or args.min_valid > args.count:
            raise ConfigError("--count must be at least 1 and --min-valid between 0 and --count")
        model = args.model
        if model is None:
            model = (load_config(args.config) if args.config else load_config()).export.ollama_tag
        dataset = load_dataset(args.dataset)
        call = chat if chat is not None else make_chat_call(args.base_url)
        report = run_eval(
            dataset,
            call,
            model,
            count=args.count,
            min_valid=args.min_valid,
            seed=args.seed,
            constrained=not args.unconstrained,
        )
    except (ConfigError, DatasetError, OllamaError) as error:
        echo(f"error: {error}")
        return EXIT_BAD_INPUT
    echo(format_report(report))
    if args.report is not None:
        write_json(args.report, json.loads(json.dumps(asdict(report))))
    return EXIT_OK if report.passed else EXIT_BELOW_TARGET


if __name__ == "__main__":
    raise SystemExit(main())
