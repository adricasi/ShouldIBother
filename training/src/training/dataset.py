"""Loads the fine-tune dataset written by `sib dataset` (REQ-019, T-031) and checks it.

A dataset folder holds `train.jsonl`, `holdout.jsonl` and `manifest.json`. The row layout is the
one `src/backtest/finetune-dataset.ts` writes: `id`, `split`, `chore`, `date`, `messages`,
`tools` and `meta`. Loading refuses a folder whose files do not match the manifest hashes, whose
rows break the schema, or whose training file holds anything from the hold-out period, so a
night of training cannot start on data that is not what the manifest promises (AC-019.1,
AC-019.6, AC-019.7, NFR-012). Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date as date_type
from pathlib import Path
from typing import Any, Protocol

from training.config import TRAINING_DIR
from training.schema import BAND_NAMES, parse_answer

FORMAT_VERSION = 1
TRAIN_FILE = "train.jsonl"
HOLDOUT_FILE = "holdout.jsonl"
MANIFEST_FILE = "manifest.json"
CHORES = ("plants", "laundry_line", "laundry_tonight", "ac", "heater")
FORECAST_TOOL = "get_forecast"
SYNTHETIC_HABITS_PATH = TRAINING_DIR / "habits.synthetic.json"
# Pinned here, not read from the manifest: a dataset whose manifest moves the boundary must not
# be able to pull hold-out days into training. They equal TRAINING_END_DATE and
# HOLDOUT_START_DATE in src/backtest/target-band.ts (a test compares the two files).
TRAINING_END = "2026-08-31"
HOLDOUT_START = "2026-09-01"
_UNTRUSTED = re.compile(r"\A<untrusted_data>\n(.*)\n</untrusted_data>\Z", re.DOTALL)

ROW_KEYS = frozenset({"id", "split", "chore", "date", "messages", "tools", "meta"})
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class DatasetError(ValueError):
    """The dataset folder is missing, altered or does not follow the row format."""


@dataclass(frozen=True)
class Row:
    id: str
    split: str
    chore: str
    date: str
    messages: tuple[dict[str, Any], ...]
    tools: tuple[dict[str, Any], ...]
    meta: dict[str, Any]


@dataclass(frozen=True)
class Dataset:
    directory: Path
    manifest: dict[str, Any]
    manifest_sha256: str
    file_sha256: dict[str, str]
    train: tuple[Row, ...]
    holdout: tuple[Row, ...]

    @property
    def prompt_version(self) -> str:
        return str(self.manifest["bookmaker_prompt"]["version"])


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _need(condition: bool, message: str) -> None:
    if not condition:
        raise DatasetError(message)


def _is_date(text: Any) -> bool:
    if not isinstance(text, str) or not _DATE.match(text):
        return False
    try:
        date_type.fromisoformat(text)
    except ValueError:
        return False
    return True


# ---------------------------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------------------------


def _read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise DatasetError(f"cannot read {path}: {error.strerror or error}") from error


def _parse_manifest(data: bytes) -> dict[str, Any]:
    try:
        manifest = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise DatasetError(f"{MANIFEST_FILE} is not valid JSON: {error}") from error
    _need(isinstance(manifest, dict), f"{MANIFEST_FILE} must be a JSON object")
    _need(
        manifest.get("format_version") == FORMAT_VERSION,
        f"{MANIFEST_FILE} has format_version {manifest.get('format_version')!r}, "
        f"this tooling reads {FORMAT_VERSION}",
    )
    prompt = manifest.get("bookmaker_prompt")
    _need(
        isinstance(prompt, dict) and isinstance(prompt.get("version"), str),
        f"{MANIFEST_FILE} lacks bookmaker_prompt.version",
    )
    _need(
        isinstance(manifest.get("rules_json_sha256"), str)
        and bool(_SHA256.match(manifest["rules_json_sha256"])),
        f"{MANIFEST_FILE} lacks rules_json_sha256",
    )
    snapshot = manifest.get("snapshot")
    _need(
        isinstance(snapshot, dict) and _is_date(snapshot.get("end_date")),
        f"{MANIFEST_FILE} lacks snapshot.end_date",
    )
    periods = manifest.get("periods")
    _need(isinstance(periods, dict), f"{MANIFEST_FILE} lacks periods")
    for split in ("train", "holdout"):
        period = periods.get(split)
        _need(
            isinstance(period, dict)
            and _is_date(period.get("from"))
            and _is_date(period.get("to")),
            f"{MANIFEST_FILE} lacks periods.{split}.from / to",
        )
        _need(period["from"] <= period["to"], f"periods.{split} ends before it starts")
    _need(
        periods["train"]["to"] < periods["holdout"]["from"],
        "the training period must end before the hold-out period starts (AC-019.1)",
    )
    _need(
        periods["train"]["to"] <= TRAINING_END,
        f"periods.train.to is {periods['train']['to']}, after {TRAINING_END}: the manifest "
        "moves the training period into the hold-out (AC-019.1)",
    )
    _need(
        periods["holdout"]["from"] == HOLDOUT_START,
        f"periods.holdout.from is {periods['holdout']['from']}, not {HOLDOUT_START} (AC-019.1)",
    )
    files = manifest.get("files")
    _need(isinstance(files, dict), f"{MANIFEST_FILE} lacks files")
    for split, expected_name in (("train", TRAIN_FILE), ("holdout", HOLDOUT_FILE)):
        entry = files.get(split)
        _need(
            isinstance(entry, dict)
            and entry.get("name") == expected_name
            and isinstance(entry.get("rows"), int)
            and isinstance(entry.get("sha256"), str)
            and bool(_SHA256.match(entry["sha256"])),
            f"{MANIFEST_FILE} files.{split} must have name {expected_name}, rows and sha256",
        )
    _check_synthetic_habits(manifest)
    return manifest


def synthetic_habits() -> dict[str, Any]:
    try:
        value = json.loads(SYNTHETIC_HABITS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DatasetError(f"cannot read {SYNTHETIC_HABITS_PATH}: {error}") from error
    _need(isinstance(value, dict), f"{SYNTHETIC_HABITS_PATH.name} must be a JSON object")
    return value


def _check_synthetic_habits(manifest: Mapping[str, Any]) -> None:
    """The habits in every row are the fixed synthetic profile, never household data (AC-019.6)."""
    habits = manifest.get("habits")
    _need(
        isinstance(habits, dict) and habits.get("profile") == "synthetic",
        "the manifest says the rows do not carry the synthetic habit profile "
        '(habits.profile must be "synthetic"); refusing to train on them (AC-019.6)',
    )
    profile = manifest.get("habit_profile")
    _need(
        profile == synthetic_habits(),
        f"manifest.habit_profile differs from {SYNTHETIC_HABITS_PATH.name}; "
        "the dataset was not built with the fixed synthetic profile (AC-019.6)",
    )


# ---------------------------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------------------------


def _check_message(where: str, message: Any) -> None:
    _need(isinstance(message, dict), f"{where}: a message must be an object")
    role = message.get("role")
    _need(role in ("system", "user", "assistant", "tool"), f"{where}: unknown role {role!r}")
    _need(isinstance(message.get("content"), str), f"{where}: {role} content must be a string")
    calls = message.get("tool_calls")
    if calls is not None:
        _need(role == "assistant", f"{where}: only an assistant message can carry tool_calls")
        _need(isinstance(calls, list) and calls, f"{where}: tool_calls must be a non-empty list")
        for call in calls:
            function = call.get("function") if isinstance(call, dict) else None
            _need(
                isinstance(call, dict)
                and call.get("type") == "function"
                and isinstance(function, dict)
                and isinstance(function.get("name"), str)
                and isinstance(function.get("arguments"), dict),
                f"{where}: a tool call must be {{type: function, function: {{name, arguments}}}}",
            )
    if role == "tool":
        _need(isinstance(message.get("name"), str), f"{where}: a tool result needs its name")


def _untrusted_json(where: str, what: str, content: str) -> dict[str, Any]:
    """The JSON object inside an `<untrusted_data>` block of a message."""
    match = _UNTRUSTED.match(content)
    _need(match is not None, f"{where}: the {what} is not an <untrusted_data> block")
    assert match is not None
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise DatasetError(f"{where}: the {what} block is not valid JSON: {error.msg}") from error
    _need(isinstance(value, dict), f"{where}: the {what} block must hold a JSON object")
    return value


def _check_row_habits(where: str, messages: list[Any]) -> None:
    """The habits the bookmaker sees in this very row are the synthetic profile (AC-019.6)."""
    data = _untrusted_json(where, "user message", messages[1]["content"])
    _need(
        data.get("habits") == synthetic_habits(),
        f"{where}: the habits in the user message are not the synthetic profile in "
        f"{SYNTHETIC_HABITS_PATH.name} (AC-019.6); household data must not enter a row",
    )


def _check_forecast_horizon(where: str, split: str, messages: list[Any]) -> None:
    """A training prompt shows no forecast hour of 1 Sep or later (AC-019.1)."""
    for message in messages:
        if message["role"] != "tool" or message["name"] != FORECAST_TOOL:
            continue
        data = _untrusted_json(where, "forecast result", message["content"])
        hours = data.get("hours")
        _need(isinstance(hours, list) and hours, f"{where}: the forecast result has no hours")
        for hour in hours:
            stamp = hour.get("time") if isinstance(hour, dict) else None
            _need(
                isinstance(stamp, str) and _is_date(stamp[:10]),
                f"{where}: a forecast hour has no valid time",
            )
            if split == "train":
                _need(
                    stamp[:10] < HOLDOUT_START,
                    f"{where}: the forecast shows {stamp}, in the hold-out period (AC-019.1)",
                )


def _check_conversation(where: str, split: str, messages: list[Any]) -> None:
    _need(isinstance(messages, list) and len(messages) >= 4, f"{where}: messages too short")
    for message in messages:
        _check_message(where, message)
    roles = [message["role"] for message in messages]
    _need(roles[0] == "system" and roles[1] == "user", f"{where}: must start with system, user")
    # The live bookmaker reads the forecast with its tool before it answers.
    called = any(
        message["role"] == "assistant"
        and any(c["function"]["name"] == FORECAST_TOOL for c in message.get("tool_calls", []))
        for message in messages
    )
    result = any(
        message["role"] == "tool" and message["name"] == FORECAST_TOOL for message in messages
    )
    _need(called and result, f"{where}: the {FORECAST_TOOL} call and its result are missing")
    last = messages[-1]
    answered = last["role"] == "assistant" and "tool_calls" not in last
    if split == "train":
        _need(answered, f"{where}: a training row must end with the assistant's answer")
    else:
        _need(not answered, f"{where}: a hold-out row must end before the answer (AC-019.1)")


def _check_meta(where: str, split: str, row: Mapping[str, Any], prompt_version: str) -> None:
    meta = row["meta"]
    _need(isinstance(meta, dict), f"{where}: meta must be an object")
    _need(
        meta.get("prompt_version") == prompt_version,
        f"{where}: meta.prompt_version {meta.get('prompt_version')!r} is not the manifest's "
        f"{prompt_version!r}",
    )
    _need(meta.get("rule_band") in BAND_NAMES, f"{where}: meta.rule_band is not a band")
    _need(isinstance(meta.get("outcome_delivered"), bool), f"{where}: meta.outcome_delivered")
    _need(isinstance(meta.get("forecast_quality"), str), f"{where}: meta.forecast_quality")
    target = meta.get("target")
    if split == "holdout":
        _need(target is None, f"{where}: a hold-out row must not carry a target (AC-019.5)")
        return

    _need(isinstance(target, dict), f"{where}: a training row needs meta.target")
    _need(target.get("band") in BAND_NAMES, f"{where}: meta.target.band is not a band")
    rate = target.get("success_rate")
    _need(
        isinstance(rate, int | float) and not isinstance(rate, bool) and 0 <= rate <= 1,
        f"{where}: meta.target.success_rate must be between 0 and 1",
    )
    neighbours = target.get("neighbours")
    _need(
        isinstance(neighbours, int) and not isinstance(neighbours, bool) and neighbours >= 0,
        f"{where}: meta.target.neighbours must be a whole number",
    )
    distance = abs(BAND_NAMES.index(target["band"]) - BAND_NAMES.index(meta["rule_band"]))
    _need(
        target.get("bands_from_rule") == distance,
        f"{where}: meta.target.bands_from_rule does not match the bands",
    )

    answer, errors = parse_answer(row["messages"][-1]["content"])
    _need(answer is not None and not errors, f"{where}: the target answer is invalid: {errors}")
    assert answer is not None
    _need(answer.get("status") == "ok", f"{where}: a training answer must have status ok")
    _need(answer.get("band") == target["band"], f"{where}: the answer band is not the target")
    if distance >= 2:
        _need(
            bool(str(answer.get("disagreement_reason", "")).strip()),
            f"{where}: two or more bands from the rule needs a disagreement_reason (AC-019.6)",
        )


def _parse_row(line: str, number: int, split: str, manifest: Mapping[str, Any]) -> Row:
    where = f"{split} line {number}"
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as error:
        raise DatasetError(f"{where}: not valid JSON: {error.msg}") from error
    _need(isinstance(raw, dict), f"{where}: a row must be a JSON object")
    _need(
        set(raw) == ROW_KEYS,
        f"{where}: row keys are {sorted(raw)}, expected {sorted(ROW_KEYS)}",
    )
    _need(raw["split"] == split, f"{where}: split is {raw['split']!r}, the file is {split}")
    _need(raw["chore"] in CHORES, f"{where}: unknown chore {raw['chore']!r}")
    _need(_is_date(raw["date"]), f"{where}: date must be YYYY-MM-DD")
    _need(raw["id"] == f"{raw['chore']}|{raw['date']}", f"{where}: id is not chore|date")
    where = f"{split} row {raw['id']}"
    period = manifest["periods"][split]
    _need(
        period["from"] <= raw["date"] <= period["to"],
        f"{where}: date {raw['date']} is outside the {split} period "
        f"{period['from']} to {period['to']} (AC-019.1)",
    )
    _need(isinstance(raw["tools"], list) and raw["tools"], f"{where}: tools must be a list")
    for tool in raw["tools"]:
        _need(
            isinstance(tool, dict)
            and tool.get("type") == "function"
            and isinstance(tool.get("function"), dict)
            and isinstance(tool["function"].get("name"), str),
            f"{where}: a tool must be {{type: function, function: {{name, ...}}}}",
        )
    _check_conversation(where, split, raw["messages"])
    _check_row_habits(where, raw["messages"])
    _check_forecast_horizon(where, split, raw["messages"])
    _check_meta(where, split, raw, manifest["bookmaker_prompt"]["version"])
    return Row(
        id=raw["id"],
        split=split,
        chore=raw["chore"],
        date=raw["date"],
        messages=tuple(raw["messages"]),
        tools=tuple(raw["tools"]),
        meta=raw["meta"],
    )


def _load_split(
    directory: Path, split: str, manifest: Mapping[str, Any]
) -> tuple[tuple[Row, ...], str]:
    entry = manifest["files"][split]
    data = _read_bytes(directory / entry["name"])
    # The hash is of the bytes that are parsed below, so the file cannot change in between.
    actual = sha256_hex(data)
    _need(
        actual == entry["sha256"],
        f"{entry['name']} does not match the manifest (sha256 {actual[:12]}... but the manifest "
        f"says {entry['sha256'][:12]}...); rebuild it with `sib dataset` or restore the file",
    )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DatasetError(f"{entry['name']} is not UTF-8: {error}") from error
    _need(text == "" or text.endswith("\n"), f"{entry['name']} does not end with a newline")
    lines = text.split("\n")[:-1]
    rows = tuple(_parse_row(line, number, split, manifest) for number, line in enumerate(lines, 1))
    _need(
        len(rows) == entry["rows"],
        f"{entry['name']} has {len(rows)} rows, the manifest says {entry['rows']}",
    )
    ids = [row.id for row in rows]
    _need(len(set(ids)) == len(ids), f"{entry['name']} repeats a row id")
    return rows, actual


def assert_no_holdout_in_training(
    train: tuple[Row, ...], holdout: tuple[Row, ...], manifest: Mapping[str, Any]
) -> None:
    """Refuses a training set that touches the hold-out: by split, by period and by date."""
    del manifest  # the boundary is pinned in this module, not taken from the data
    for row in train:
        _need(row.split == "train", f"hold-out row {row.id} is in the training set (AC-019.1)")
        _need(
            row.date < HOLDOUT_START,
            f"training row {row.id} is dated {row.date}, in the hold-out period (AC-019.1)",
        )
    shared = {row.date for row in train} & {row.date for row in holdout}
    _need(
        not shared,
        f"dates in both training and hold-out: {', '.join(sorted(shared)[:3])} (AC-019.1)",
    )
    train_ids = {row.id for row in train}
    _need(
        not train_ids & {row.id for row in holdout},
        "a row id is in both training and hold-out (AC-019.1)",
    )


def load_dataset(directory: Path | str) -> Dataset:
    """Loads and checks a dataset folder; raises `DatasetError` with a one-line reason."""
    folder = Path(directory).expanduser()
    _need(folder.is_dir(), f"dataset folder not found: {folder}")
    manifest_bytes = _read_bytes(folder / MANIFEST_FILE)
    manifest = _parse_manifest(manifest_bytes)
    train, train_hash = _load_split(folder, "train", manifest)
    holdout, holdout_hash = _load_split(folder, "holdout", manifest)
    assert_no_holdout_in_training(train, holdout, manifest)
    return Dataset(
        directory=folder,
        manifest=manifest,
        manifest_sha256=sha256_hex(manifest_bytes),
        file_sha256={"train": train_hash, "holdout": holdout_hash},
        train=train,
        holdout=holdout,
    )


# ---------------------------------------------------------------------------------------------
# Chat messages for training and evaluation
# ---------------------------------------------------------------------------------------------


def to_example(row: Row) -> dict[str, Any]:
    """A training row as chat messages: everything up to the tool result is the prompt (system,
    user, assistant tool call, tool result), the final assistant message is the completion."""
    _need(row.split == "train", f"{row.id}: only training rows become training examples")
    return {
        "prompt": [dict(message) for message in row.messages[:-1]],
        "completion": [dict(row.messages[-1])],
        "tools": [dict(tool) for tool in row.tools],
    }


def training_examples(dataset: Dataset) -> list[dict[str, Any]]:
    """The training set only: the hold-out never reaches the trainer."""
    assert_no_holdout_in_training(dataset.train, dataset.holdout, dataset.manifest)
    return [to_example(row) for row in dataset.train]


class ChatTemplate(Protocol):
    def apply_chat_template(self, conversation: Any, **kwargs: Any) -> str: ...


def render_example(example: Mapping[str, Any], tokenizer: ChatTemplate) -> dict[str, str]:
    """Renders an example with the model's own chat template as `{prompt, completion}` text.

    The prompt ends where the model must start writing (generation prompt); the completion is
    exactly what the template adds for the final assistant message, so the loss can be limited to
    it and the format cannot drift from what Ollama's template shows the model.
    """
    prompt_messages = list(example["prompt"])
    tools = list(example["tools"])
    prompt = tokenizer.apply_chat_template(
        prompt_messages, tools=tools, tokenize=False, add_generation_prompt=True
    )
    full = tokenizer.apply_chat_template(
        prompt_messages + list(example["completion"]), tools=tools, tokenize=False
    )
    _need(
        isinstance(prompt, str) and isinstance(full, str) and full.startswith(prompt),
        "the chat template does not render the prompt as a prefix of the full conversation; "
        "check the template before training",
    )
    completion = full[len(prompt) :]
    _need(completion.strip() != "", "the chat template renders an empty completion")
    return {"prompt": prompt, "completion": completion}
