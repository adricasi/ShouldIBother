import copy
import tomllib
from pathlib import Path
from typing import Any

import pytest

from training.config import (
    DEFAULT_CONFIG_PATH,
    REPOSITORY_ROOT,
    ConfigError,
    load_config,
    parse_config,
)


def raw() -> dict[str, Any]:
    with DEFAULT_CONFIG_PATH.open("rb") as handle:
        return tomllib.load(handle)


def test_the_committed_config_loads_and_validates() -> None:
    config = load_config(DEFAULT_CONFIG_PATH)
    assert config.training.seed == 42
    assert config.model.load_in_4bit is True
    assert config.lora.target_modules[0] == "q_proj"
    assert config.training.effective_batch_size == 16
    assert config.paths.output_dir.is_absolute()
    assert config.paths.dataset_dir is None
    assert config.export.template_file is None


def test_unverified_settings_are_listed_for_the_builder() -> None:
    config = load_config(DEFAULT_CONFIG_PATH)
    assert "model.base_id" in config.unverified
    assert "lora.target_modules" in config.unverified


def test_paths_derive_from_one_output_folder() -> None:
    paths = load_config(DEFAULT_CONFIG_PATH).paths
    assert paths.adapter_dir == paths.output_dir / "adapter"
    assert paths.merged_dir == paths.output_dir / "merged"
    assert paths.gguf_dir == paths.output_dir / "gguf"
    assert paths.checkpoints_dir == paths.output_dir / "checkpoints"


def test_as_dict_is_json_ready() -> None:
    import json

    text = json.dumps(load_config(DEFAULT_CONFIG_PATH).as_dict())
    assert '"seed": 42' in text


def test_a_missing_file_is_a_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_config(tmp_path / "nope.toml")


def test_invalid_toml_is_a_config_error(tmp_path: Path) -> None:
    path = tmp_path / "bad.toml"
    path.write_text("[model\nbase_id =", encoding="utf-8")
    with pytest.raises(ConfigError, match="cannot read"):
        load_config(path)


def test_unknown_keys_are_rejected_so_typos_fail_early() -> None:
    data = raw()
    data["training"]["learnin_rate"] = 1.0
    with pytest.raises(ConfigError, match="unknown keys: learnin_rate"):
        parse_config(data)
    data = raw()
    data["extra"] = {}
    with pytest.raises(ConfigError, match="unknown top-level keys: extra"):
        parse_config(data)


def test_a_missing_required_key_is_named() -> None:
    data = raw()
    del data["lora"]["r"]
    with pytest.raises(ConfigError, match=r"\[lora\] needs r"):
        parse_config(data)
    data = raw()
    del data["model"]
    with pytest.raises(ConfigError, match=r"\[model\] is missing"):
        parse_config(data)


@pytest.mark.parametrize(
    ("table", "key", "value", "message"),
    [
        ("training", "seed", "42", "whole number"),
        ("training", "seed", True, "whole number"),
        ("training", "learning_rate", "fast", "must be a number"),
        ("training", "bf16", 1, "true or false"),
        ("model", "base_id", 7, "must be a string"),
        ("lora", "target_modules", "q_proj", "list of strings"),
        ("training", "seed", -1, "must not be negative"),
        ("training", "learning_rate", 0.0, "greater than 0"),
        ("training", "max_steps", 0, "-1"),
        ("training", "max_steps", -5, "-1"),
        ("training", "per_device_train_batch_size", 0, "greater than 0"),
        ("training", "gradient_accumulation_steps", 0, "greater than 0"),
        ("training", "warmup_ratio", 1.0, "warmup_ratio"),
        ("training", "lr_scheduler_type", "zigzag", "lr_scheduler_type"),
        ("model", "base_id", "  ", "must not be empty"),
        ("model", "max_seq_length", 0, "greater than 0"),
        ("model", "bnb_4bit_quant_type", "int3", "bnb_4bit_quant_type"),
        ("lora", "r", 0, "greater than 0"),
        ("lora", "dropout", 1.0, r"\[0, 1\)"),
        ("lora", "target_modules", [], "at least one"),
        ("lora", "target_modules", ["q_proj", "q_proj"], "repeat"),
        ("lora", "bias", "some", "bias"),
        ("export", "quantization", "Q4 K M", "one word"),
        ("export", "ollama_tag", "my tag", "without spaces"),
        ("export", "num_ctx", 0, "greater than 0"),
    ],
)
def test_bad_values_are_rejected(table: str, key: str, value: Any, message: str) -> None:
    data = copy.deepcopy(raw())
    data[table][key] = value
    with pytest.raises(ConfigError, match=message):
        parse_config(data)


def test_epochs_may_be_zero_only_when_max_steps_is_set() -> None:
    data = raw()
    data["training"]["num_train_epochs"] = 0
    with pytest.raises(ConfigError, match="num_train_epochs"):
        parse_config(data)
    data["training"]["max_steps"] = 50
    assert parse_config(data).training.max_steps == 50


def test_an_integer_is_accepted_where_a_float_is_expected() -> None:
    data = raw()
    data["training"]["learning_rate"] = 1
    assert parse_config(data).training.learning_rate == 1.0


def test_relative_paths_are_refused() -> None:
    data = raw()
    data["paths"]["output_dir"] = "out/run"
    with pytest.raises(ConfigError, match="absolute"):
        parse_config(data)


def test_outputs_inside_the_repository_are_refused() -> None:
    data = raw()
    data["paths"]["output_dir"] = str(REPOSITORY_ROOT / "training" / "out")
    with pytest.raises(ConfigError, match="inside the repository"):
        parse_config(data)


def test_optional_paths_are_resolved(tmp_path: Path) -> None:
    data = raw()
    data["paths"]["dataset_dir"] = str(tmp_path / "ds")
    data["export"]["template_file"] = str(tmp_path / "template.txt")
    config = parse_config(data)
    assert config.paths.dataset_dir == tmp_path / "ds"
    assert config.export.template_file == tmp_path / "template.txt"


def test_the_committed_config_leaves_the_revision_for_the_builder_to_pin() -> None:
    config = load_config(DEFAULT_CONFIG_PATH)
    assert config.model.revision == ""
    with pytest.raises(ConfigError, match="model.revision is empty"):
        config.model.require_pinned()


@pytest.mark.parametrize("revision", ["main", "abc123", "A" * 40, "g" * 40, "a" * 41])
def test_a_revision_must_be_a_full_lowercase_commit_hash(revision: str) -> None:
    data = raw()
    data["model"]["revision"] = revision
    with pytest.raises(ConfigError, match="40-character commit"):
        parse_config(data)


def test_a_pinned_revision_is_passed_with_remote_code_off() -> None:
    data = raw()
    data["model"]["revision"] = "ab" * 20
    model = parse_config(data).model
    model.require_pinned()
    assert model.hub_kwargs() == {"revision": "ab" * 20, "trust_remote_code": False}
