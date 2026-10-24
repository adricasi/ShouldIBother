import copy
import json
from pathlib import Path
from typing import Any

import pytest
from helpers import FIXTURE_DATASET, copy_dataset, rewrite_dataset

from training.dataset import (
    Dataset,
    DatasetError,
    Row,
    assert_no_holdout_in_training,
    load_dataset,
    render_example,
    sha256_hex,
    to_example,
    training_examples,
)


@pytest.fixture(scope="module")
def dataset() -> Dataset:
    return load_dataset(FIXTURE_DATASET)


def test_the_fixture_dataset_loads(dataset: Dataset) -> None:
    assert (len(dataset.train), len(dataset.holdout)) == (20, 7)
    assert dataset.prompt_version == "bookmaker.v1"
    manifest_bytes = (FIXTURE_DATASET / "manifest.json").read_bytes()
    assert dataset.manifest_sha256 == sha256_hex(manifest_bytes)
    assert set(dataset.file_sha256) == {"train", "holdout"}


def test_training_rows_end_with_the_answer_and_holdout_rows_before_it(dataset: Dataset) -> None:
    train = dataset.train[0]
    assert [m["role"] for m in train.messages] == [
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
    ]
    holdout = dataset.holdout[0]
    assert [m["role"] for m in holdout.messages] == ["system", "user", "assistant", "tool"]
    assert holdout.meta.get("target") is None


def test_AC_019_6_rows_are_the_live_conversation_with_the_forecast_tool(dataset: Dataset) -> None:
    row = dataset.train[0]
    call = row.messages[2]["tool_calls"][0]["function"]
    assert call["name"] == "get_forecast"
    assert row.messages[3]["name"] == "get_forecast"
    assert row.tools[0]["function"]["name"] == "get_forecast"


def test_AC_019_6_a_disagreement_reason_is_present_two_or_more_bands_from_the_rule(
    dataset: Dataset,
) -> None:
    far = [r for r in dataset.train if r.meta["target"]["bands_from_rule"] >= 2]
    near = [r for r in dataset.train if r.meta["target"]["bands_from_rule"] < 2]
    assert far
    assert near
    assert all("disagreement_reason" in json.loads(r.messages[-1]["content"]) for r in far)


def test_to_example_splits_the_prompt_from_the_answer(dataset: Dataset) -> None:
    example = to_example(dataset.train[0])
    assert [m["role"] for m in example["prompt"]] == ["system", "user", "assistant", "tool"]
    assert [m["role"] for m in example["completion"]] == ["assistant"]
    assert json.loads(example["completion"][0]["content"])["status"] == "ok"
    assert example["tools"][0]["function"]["name"] == "get_forecast"


def test_AC_019_1_only_training_rows_become_training_examples(dataset: Dataset) -> None:
    examples = training_examples(dataset)
    assert len(examples) == 20
    with pytest.raises(DatasetError, match="only training rows"):
        to_example(dataset.holdout[0])


def test_AC_019_7_a_changed_data_file_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    train = folder / "train.jsonl"
    train.write_bytes(train.read_bytes().replace(b"likely", b"unlikely", 1))
    with pytest.raises(DatasetError, match=r"train\.jsonl does not match the manifest"):
        load_dataset(folder)


def test_a_changed_holdout_file_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    holdout = folder / "holdout.jsonl"
    holdout.write_bytes(holdout.read_bytes() + b"\n")
    with pytest.raises(DatasetError, match=r"holdout\.jsonl does not match the manifest"):
        load_dataset(folder)


def test_a_missing_folder_or_file_is_a_dataset_error(tmp_path: Path) -> None:
    with pytest.raises(DatasetError, match="not found"):
        load_dataset(tmp_path / "missing")
    folder = copy_dataset(tmp_path / "ds")
    (folder / "train.jsonl").unlink()
    with pytest.raises(DatasetError, match="cannot read"):
        load_dataset(folder)


def test_a_manifest_that_is_not_json_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    (folder / "manifest.json").write_text("{", encoding="utf-8")
    with pytest.raises(DatasetError, match="not valid JSON"):
        load_dataset(folder)


def test_AC_019_1_a_holdout_row_in_the_training_file_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    holdout_row = json.loads((folder / "holdout.jsonl").read_text().splitlines()[0])

    rewrite_dataset(folder, train=lambda rows: [*rows, holdout_row])
    with pytest.raises(DatasetError, match="split is 'holdout', the file is train"):
        load_dataset(folder)


def test_AC_019_1_a_training_row_dated_in_the_holdout_period_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def move_into_holdout(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows = copy.deepcopy(rows)
        rows[0]["date"] = "2026-09-01"
        rows[0]["id"] = f"{rows[0]['chore']}|2026-09-01"
        return rows

    rewrite_dataset(folder, train=move_into_holdout)
    with pytest.raises(DatasetError, match="outside the train period"):
        load_dataset(folder)


def test_AC_019_1_a_holdout_row_dated_in_the_training_period_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def move_into_training(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows = copy.deepcopy(rows)
        rows[0]["date"] = "2026-08-30"
        rows[0]["id"] = f"{rows[0]['chore']}|2026-08-30"
        return rows

    rewrite_dataset(folder, holdout=move_into_training)
    with pytest.raises(DatasetError, match="outside the holdout period"):
        load_dataset(folder)


def test_AC_019_1_the_guard_refuses_a_holdout_row_or_a_shared_date(dataset: Dataset) -> None:
    holdout_row = dataset.holdout[0]
    with pytest.raises(DatasetError, match="in the training set"):
        assert_no_holdout_in_training(
            (*dataset.train, holdout_row), dataset.holdout, dataset.manifest
        )

    late = Row(**{**vars(dataset.train[0]), "date": "2026-09-01", "id": "plants|2026-09-01"})
    with pytest.raises(DatasetError, match="hold-out period"):
        assert_no_holdout_in_training((late,), dataset.holdout, dataset.manifest)

    same_date = Row(**{**vars(dataset.train[0]), "date": dataset.holdout[0].date})
    manifest = copy.deepcopy(dataset.manifest)
    manifest["periods"]["holdout"]["from"] = "2026-09-30"
    with pytest.raises(DatasetError, match="in both"):
        assert_no_holdout_in_training((same_date,), dataset.holdout, manifest)


def test_AC_019_5_a_holdout_row_with_a_target_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    target = json.loads((folder / "train.jsonl").read_text().splitlines()[0])["meta"]["target"]

    def add_target(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["meta"]["target"] = target
        return rows

    rewrite_dataset(folder, holdout=add_target)
    with pytest.raises(DatasetError, match="must not carry a target"):
        load_dataset(folder)


def test_AC_019_6_a_custom_habit_profile_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def custom(manifest: dict[str, Any]) -> None:
        manifest["habits"]["profile"] = "custom"

    rewrite_dataset(folder, manifest=custom)
    with pytest.raises(DatasetError, match="synthetic habit profile"):
        load_dataset(folder)


def test_AC_019_6_habits_that_differ_from_the_synthetic_file_are_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def other_habits(manifest: dict[str, Any]) -> None:
        manifest["habit_profile"]["washing"] = "something else"

    rewrite_dataset(folder, manifest=other_habits)
    with pytest.raises(DatasetError, match="habit_profile differs"):
        load_dataset(folder)


def test_AC_019_6_a_missing_disagreement_reason_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def strip_reason(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for row in rows:
            answer = json.loads(row["messages"][-1]["content"])
            if "disagreement_reason" in answer:
                del answer["disagreement_reason"]
                row["messages"][-1]["content"] = json.dumps(answer)
                break
        return rows

    rewrite_dataset(folder, train=strip_reason)
    with pytest.raises(DatasetError, match="needs a disagreement_reason"):
        load_dataset(folder)


def test_a_training_row_without_an_answer_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    rewrite_dataset(folder, train=lambda rows: [{**rows[0], "messages": rows[0]["messages"][:-1]}])
    with pytest.raises(DatasetError, match="must end with the assistant's answer"):
        load_dataset(folder)


def test_a_holdout_row_that_includes_an_answer_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    answer = json.loads((folder / "train.jsonl").read_text().splitlines()[0])["messages"][-1]

    def add_answer(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["messages"].append(answer)
        return rows

    rewrite_dataset(folder, holdout=add_answer)
    with pytest.raises(DatasetError, match="must end before the answer"):
        load_dataset(folder)


def test_a_row_without_the_forecast_tool_call_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def drop_tool(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["messages"] = [
            rows[0]["messages"][0],
            rows[0]["messages"][1],
            rows[0]["messages"][-1],
        ]
        return rows

    rewrite_dataset(folder, train=drop_tool)
    with pytest.raises(DatasetError, match="messages too short"):
        load_dataset(folder)


def test_an_invalid_target_answer_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def bad_answer(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["messages"][-1]["content"] = '{"status": "ok"}'
        return rows

    rewrite_dataset(folder, train=bad_answer)
    with pytest.raises(DatasetError, match="target answer is invalid"):
        load_dataset(folder)


def test_an_answer_band_that_is_not_the_target_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def wrong_band(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["meta"]["target"]["band"] = "toss_up"
        rows[0]["meta"]["target"]["bands_from_rule"] = 1
        return rows

    rewrite_dataset(folder, train=wrong_band)
    with pytest.raises(DatasetError, match="answer band is not the target"):
        load_dataset(folder)


def test_extra_or_missing_row_keys_are_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    rewrite_dataset(folder, train=lambda rows: [{**rows[0], "extra": 1}, *rows[1:]])
    with pytest.raises(DatasetError, match="row keys are"):
        load_dataset(folder)


def test_a_prompt_version_that_differs_from_the_manifest_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def other_prompt(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["meta"]["prompt_version"] = "bookmaker.v9"
        return rows

    rewrite_dataset(folder, train=other_prompt)
    with pytest.raises(DatasetError, match="prompt_version"):
        load_dataset(folder)


def test_a_repeated_row_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    rewrite_dataset(folder, train=lambda rows: [*rows, rows[0]])
    with pytest.raises(DatasetError, match="repeats a row id"):
        load_dataset(folder)


def test_a_row_count_that_differs_from_the_manifest_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def lie(manifest: dict[str, Any]) -> None:
        manifest["files"]["train"]["rows"] = 99

    rewrite_dataset(folder, manifest=lie)
    # rewrite_dataset set the true count first; the manifest hook then overrides it.
    with pytest.raises(DatasetError, match="the manifest says 99"):
        load_dataset(folder)


def test_a_line_that_is_not_json_or_not_an_object_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    path = folder / "train.jsonl"
    path.write_text("not json\n", encoding="utf-8")
    meta = json.loads((folder / "manifest.json").read_text())
    meta["files"]["train"].update(rows=1, sha256=sha256_hex(path.read_bytes()))
    (folder / "manifest.json").write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(DatasetError, match="train line 1: not valid JSON"):
        load_dataset(folder)


def test_the_training_period_must_end_before_the_holdout_starts(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def overlap(manifest: dict[str, Any]) -> None:
        manifest["periods"]["train"]["to"] = "2026-09-05"

    rewrite_dataset(folder, manifest=overlap)
    with pytest.raises(DatasetError, match="must end before the hold-out"):
        load_dataset(folder)


class FakeTokenizer:
    """Renders `<|role|>content<|end|>` per message, like a chat template would."""

    def __init__(self, *, broken: bool = False) -> None:
        self.broken = broken
        self.tools_seen: list[Any] = []

    def apply_chat_template(
        self,
        conversation: list[dict[str, Any]],
        *,
        tools: list[Any] | None = None,
        tokenize: bool = False,
        add_generation_prompt: bool = False,
    ) -> str:
        assert tokenize is False
        self.tools_seen.append(tools)
        parts = [f"<|{m['role']}|>{m['content']}<|end|>" for m in conversation]
        if add_generation_prompt:
            parts.append("<|assistant|>" if not self.broken else "<|model|>")
        return "".join(parts)


def test_render_example_splits_prompt_and_completion_at_the_generation_prompt() -> None:
    example = {
        "prompt": [{"role": "user", "content": "hi"}],
        "completion": [{"role": "assistant", "content": "ok"}],
        "tools": [{"type": "function"}],
    }
    tokenizer = FakeTokenizer()
    rendered = render_example(example, tokenizer)
    assert rendered["prompt"] == "<|user|>hi<|end|><|assistant|>"
    # The completion is what the template adds after the generation prompt, end marker included.
    assert rendered["prompt"] + rendered["completion"] != rendered["prompt"]
    assert rendered["completion"].endswith("<|end|>")
    assert tokenizer.tools_seen == [[{"type": "function"}]] * 2


def test_render_example_refuses_a_template_whose_prompt_is_not_a_prefix() -> None:
    example = {
        "prompt": [{"role": "user", "content": "hi"}],
        "completion": [{"role": "assistant", "content": "ok"}],
        "tools": [],
    }
    with pytest.raises(DatasetError, match="prefix"):
        render_example(example, FakeTokenizer(broken=True))
