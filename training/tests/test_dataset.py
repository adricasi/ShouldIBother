import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest
from fakes import FakeTokenizer
from helpers import FIXTURE_DATASET, copy_dataset, rewrite_dataset

from training.config import REPOSITORY_ROOT
from training.dataset import (
    HOLDOUT_START,
    TRAINING_END,
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

    day = dataset.train[0].date
    same_date = Row(**{**vars(dataset.holdout[0]), "date": day})
    with pytest.raises(DatasetError, match="in both"):
        assert_no_holdout_in_training(dataset.train, (same_date,), dataset.manifest)


def test_the_boundary_is_pinned_in_python_and_matches_the_typescript_constants() -> None:
    source = (REPOSITORY_ROOT / "src" / "backtest" / "target-band.ts").read_text(encoding="utf-8")
    training_end = re.search(r'TRAINING_END_DATE\s*=\s*"(\d{4}-\d{2}-\d{2})"', source)
    holdout_start = re.search(r'HOLDOUT_START_DATE\s*=\s*"(\d{4}-\d{2}-\d{2})"', source)
    assert training_end is not None
    assert holdout_start is not None
    assert training_end.group(1) == TRAINING_END
    assert holdout_start.group(1) == HOLDOUT_START


def test_AC_019_1_a_manifest_that_moves_the_boundary_is_refused(tmp_path: Path) -> None:
    def later_holdout(manifest: dict[str, Any]) -> None:
        manifest["periods"]["holdout"]["from"] = "2026-09-05"
        manifest["periods"]["holdout"]["to"] = "2026-09-30"

    folder = copy_dataset(tmp_path / "late")
    rewrite_dataset(folder, manifest=later_holdout)
    with pytest.raises(DatasetError, match=r"periods\.holdout\.from is 2026-09-05"):
        load_dataset(folder)

    def longer_training(manifest: dict[str, Any]) -> None:
        manifest["periods"]["train"]["to"] = "2026-09-01"
        manifest["periods"]["holdout"]["from"] = "2026-09-02"
        manifest["periods"]["holdout"]["to"] = "2026-09-30"

    folder = copy_dataset(tmp_path / "long")
    rewrite_dataset(folder, manifest=longer_training)
    with pytest.raises(DatasetError, match=r"periods\.train\.to is 2026-09-01"):
        load_dataset(folder)


def test_AC_019_1_a_training_forecast_that_reaches_into_september_is_refused(
    tmp_path: Path,
) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def reach_into_september(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        content = rows[0]["messages"][3]["content"]
        rows[0]["messages"][3]["content"] = content.replace(
            f'"time":"{rows[0]["date"]} 19:00"', '"time":"2026-09-01 00:00"', 1
        )
        assert "2026-09-01 00:00" in rows[0]["messages"][3]["content"]
        return rows

    rewrite_dataset(folder, train=reach_into_september)
    with pytest.raises(DatasetError, match="forecast shows 2026-09-01 00:00"):
        load_dataset(folder)


def test_a_holdout_forecast_may_reach_into_september(dataset: Dataset) -> None:
    # Hold-out prompts are dated in September; only training prompts are bounded.
    assert any("2026-09-" in row.messages[3]["content"] for row in dataset.holdout)


def test_AC_019_6_swapped_habits_in_one_row_are_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def swap_habits(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        message = rows[3]["messages"][1]
        message["content"] = message["content"].replace(
            "two or three loads a week, mostly in the morning", "a load every day at six"
        )
        assert "a load every day at six" in message["content"]
        return rows

    rewrite_dataset(folder, train=swap_habits)
    with pytest.raises(DatasetError, match="habits in the user message are not the synthetic"):
        load_dataset(folder)

    folder = copy_dataset(tmp_path / "holdout")

    def swap_holdout(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["messages"][1]["content"] = rows[0]["messages"][1]["content"].replace(
            '"habits":{', '"habits":{"extra":"x",', 1
        )
        return rows

    rewrite_dataset(folder, holdout=swap_holdout)
    with pytest.raises(DatasetError, match="not the synthetic profile"):
        load_dataset(folder)


def test_a_user_message_that_is_not_an_untrusted_block_is_refused(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")

    def plain(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows[0]["messages"][1]["content"] = "just text"
        return rows

    rewrite_dataset(folder, train=plain)
    with pytest.raises(DatasetError, match="not an <untrusted_data> block"):
        load_dataset(folder)


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
