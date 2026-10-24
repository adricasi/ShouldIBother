import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from helpers import FIXTURE_DATASET, copy_dataset, write_config

from training import train
from training.config import REPOSITORY_ROOT, load_config
from training.dataset import load_dataset
from training.ollama import OllamaError, OllamaStatus

SRC = Path(train.__file__).parents[1]
IDLE = OllamaStatus(reachable=False)


class Recorder:
    """A stand-in for `run_training` that records the call instead of using a GPU."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, config: Any, dataset: Any, output_dir: Path, *, resume: bool) -> None:
        self.calls.append({"output_dir": output_dir, "resume": resume, "rows": len(dataset.train)})


def run(
    tmp_path: Path,
    *extra: str,
    probe: Any = lambda: IDLE,
    trainer: Any = None,
    dataset: Path = FIXTURE_DATASET,
) -> tuple[int, str, Path]:
    output = tmp_path / "out"
    config = write_config(tmp_path, output_dir=output)
    lines: list[str] = []
    code = train.main(
        ["--config", str(config), "--dataset", str(dataset), *extra],
        ollama_probe=probe,
        trainer=trainer or Recorder(),
        echo=lines.append,
    )
    return code, "\n".join(lines), output


def test_the_dry_run_prints_the_plan_and_writes_nothing(tmp_path: Path) -> None:
    recorder = Recorder()
    code, text, output = run(tmp_path, "--dry-run", trainer=recorder)
    assert code == 0
    assert "Training plan (dry run)" in text
    assert "google/gemma-4-E4B-it" in text
    assert "20 training, 7 hold-out" in text
    manifest_hash = load_dataset(FIXTURE_DATASET).manifest_sha256
    assert manifest_hash in text
    assert "seed           42" in text
    assert "UNVERIFIED" in text
    assert recorder.calls == []
    assert not output.exists()


def test_NFR_012_the_dry_run_imports_no_ml_library(tmp_path: Path) -> None:
    code = f"""
import json, sys
sys.path.insert(0, {str(SRC)!r})
from training import train
from training.ollama import OllamaStatus
rc = train.main(
    ["--dataset", {str(FIXTURE_DATASET)!r}, "--output-dir", {str(tmp_path / "out")!r}, "--dry-run"],
    ollama_probe=lambda: OllamaStatus(reachable=False),
    echo=lambda line: None,
)
heavy = [m for m in ("torch", "transformers", "trl", "peft", "bitsandbytes", "datasets")
         if m in sys.modules]
print(json.dumps({{"rc": rc, "heavy": heavy}}))
"""
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert json.loads(result.stdout) == {"rc": 0, "heavy": []}


def test_the_plan_arithmetic_follows_the_config(tmp_path: Path) -> None:
    config = load_config(write_config(tmp_path, output_dir=tmp_path / "out"))
    plan = train.build_plan(config, load_dataset(FIXTURE_DATASET))
    # 20 rows, batch 1 x 16 accumulation: 2 optimizer steps per epoch, 2 epochs.
    assert (plan.train_rows, plan.effective_batch_size) == (20, 16)
    assert (plan.steps_per_epoch, plan.total_steps) == (2, 4)
    assert plan.holdout_rows_not_used == 7


def test_a_too_short_sequence_length_is_warned_about(tmp_path: Path) -> None:
    config_path = write_config(tmp_path, output_dir=tmp_path / "out")
    text = config_path.read_text().replace("max_seq_length = 4096", "max_seq_length = 512")
    config_path.write_text(text)
    lines: list[str] = []
    code = train.main(
        ["--config", str(config_path), "--dataset", str(FIXTURE_DATASET), "--dry-run"],
        ollama_probe=lambda: IDLE,
        echo=lines.append,
    )
    assert code == 0
    assert "WARNING" in "\n".join(lines)
    assert "answer at its end would be cut off" in "\n".join(lines)


def test_the_run_refuses_to_start_while_ollama_has_a_model_loaded(tmp_path: Path) -> None:
    recorder = Recorder()
    busy = OllamaStatus(reachable=True, loaded_models=("gemma4:e4b",))
    code, text, output = run(tmp_path, probe=lambda: busy, trainer=recorder)
    assert code == train.EXIT_GPU_BUSY
    assert "One GPU user at a time" in text
    assert "ollama stop" in text
    assert recorder.calls == []
    assert not output.exists()


def test_the_dry_run_says_it_would_refuse_when_ollama_is_busy(tmp_path: Path) -> None:
    busy = OllamaStatus(reachable=True, loaded_models=("gemma4:e4b",))
    code, text, _ = run(tmp_path, "--dry-run", probe=lambda: busy)
    assert code == 0
    assert "WOULD REFUSE TO START" in text


def test_the_run_refuses_when_it_cannot_tell_whether_ollama_is_busy(tmp_path: Path) -> None:
    def broken() -> OllamaStatus:
        raise OllamaError("unexpected answer")

    recorder = Recorder()
    code, text, _ = run(tmp_path, probe=broken, trainer=recorder)
    assert code == train.EXIT_GPU_BUSY
    assert "not starting" in text
    assert recorder.calls == []
    code, text, _ = run(tmp_path, "--dry-run", probe=broken)
    assert code == 0
    assert "could not be checked" in text


def test_a_running_ollama_without_a_loaded_model_does_not_block(tmp_path: Path) -> None:
    recorder = Recorder()
    code, _, _ = run(tmp_path, probe=lambda: OllamaStatus(reachable=True), trainer=recorder)
    assert code == 0
    assert len(recorder.calls) == 1


def test_NFR_012_the_run_record_logs_config_manifest_hash_and_versions(tmp_path: Path) -> None:
    recorder = Recorder()
    code, _, output = run(tmp_path, trainer=recorder)
    assert code == 0
    assert recorder.calls == [{"output_dir": output, "resume": False, "rows": 20}]

    record = json.loads((output / "run-record.json").read_text())
    manifest_bytes = (FIXTURE_DATASET / "manifest.json").read_bytes()
    dataset = load_dataset(FIXTURE_DATASET)
    assert record["config"]["training"]["seed"] == 42
    assert record["config"]["model"]["base_id"] == "google/gemma-4-E4B-it"
    assert record["seeds"] == {"seed": 42, "data_seed": 42}
    assert record["dataset"]["manifest_sha256"] == dataset.manifest_sha256
    assert record["dataset"]["file_sha256"] == dataset.file_sha256
    assert record["dataset"]["prompt_version"] == "bookmaker.v1"
    assert record["dataset"]["rows"] == {"train": 20, "holdout": 7}
    assert set(record["packages"]) >= {"torch", "transformers", "trl", "peft", "bitsandbytes"}
    assert record["environment"]["python"].startswith("3.12")
    assert record["unverified"]
    assert (output / "dataset-manifest.json").read_bytes() == manifest_bytes


def test_a_second_run_in_the_same_folder_needs_resume(tmp_path: Path) -> None:
    recorder = Recorder()
    assert run(tmp_path, trainer=recorder)[0] == 0
    code, text, _ = run(tmp_path, trainer=recorder)
    assert code == train.EXIT_RUN_EXISTS
    assert "--resume" in text
    assert len(recorder.calls) == 1
    code, _, _ = run(tmp_path, "--resume", trainer=recorder)
    assert code == 0
    assert recorder.calls[-1]["resume"] is True


def test_a_tampered_dataset_stops_before_any_training(tmp_path: Path) -> None:
    folder = copy_dataset(tmp_path / "ds")
    (folder / "train.jsonl").write_bytes((folder / "train.jsonl").read_bytes() + b" ")
    recorder = Recorder()
    code, text, output = run(tmp_path, dataset=folder, trainer=recorder)
    assert code == train.EXIT_BAD_INPUT
    assert "does not match the manifest" in text
    assert recorder.calls == []
    assert not output.exists()


def test_a_dataset_is_required(tmp_path: Path) -> None:
    config = write_config(tmp_path, output_dir=tmp_path / "out")
    lines: list[str] = []
    code = train.main(["--config", str(config), "--dry-run"], echo=lines.append)
    assert code == train.EXIT_BAD_INPUT
    assert "no dataset" in lines[0]


def test_the_dataset_may_come_from_the_config(tmp_path: Path) -> None:
    config = write_config(tmp_path, output_dir=tmp_path / "out")
    config.write_text(
        config.read_text().replace('dataset_dir = ""', f'dataset_dir = "{FIXTURE_DATASET}"')
    )
    lines: list[str] = []
    code = train.main(
        ["--config", str(config), "--dry-run"], ollama_probe=lambda: IDLE, echo=lines.append
    )
    assert code == 0


def test_a_bad_config_is_reported_not_raised(tmp_path: Path) -> None:
    lines: list[str] = []
    code = train.main(
        ["--config", str(tmp_path / "missing.toml"), "--dataset", str(FIXTURE_DATASET)],
        echo=lines.append,
    )
    assert code == train.EXIT_BAD_INPUT
    assert "not found" in lines[0]


def test_an_output_folder_inside_the_repository_is_refused(tmp_path: Path) -> None:
    config = write_config(tmp_path, output_dir=tmp_path / "out")
    lines: list[str] = []
    code = train.main(
        [
            "--config",
            str(config),
            "--dataset",
            str(FIXTURE_DATASET),
            "--output-dir",
            str(REPOSITORY_ROOT / "training" / "out-run"),
            "--dry-run",
        ],
        ollama_probe=lambda: IDLE,
        echo=lines.append,
    )
    assert code == train.EXIT_BAD_INPUT
    assert "inside the repository" in lines[0]


def test_NFR_012_one_seed_is_set_everywhere(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import os
    import random
    import types

    seen: list[int] = []
    fake = types.ModuleType("transformers")
    fake.set_seed = seen.append  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", fake)
    monkeypatch.delenv("PYTHONHASHSEED", raising=False)
    train.seed_everything(1234)
    first = random.random()
    train.seed_everything(1234)
    assert random.random() == first
    assert seen == [1234, 1234]
    assert os.environ["PYTHONHASHSEED"] == "1234"
    monkeypatch.delenv("PYTHONHASHSEED", raising=False)
