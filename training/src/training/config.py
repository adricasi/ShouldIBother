"""Typed, validated configuration of the bookmaker fine-tune (REQ-019, NFR-012).

The config lives in a TOML file (`configs/bookmaker-qlora.toml`). Loading rejects unknown keys,
wrong types and out-of-range values, so a typo fails before a night of GPU time starts.
Only the standard library is used: this module is imported by the CI tests and by `--dry-run`.
"""

from __future__ import annotations

import dataclasses
import tomllib
import typing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# training/src/training/config.py -> the repository root. Outputs must not land inside it.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
TRAINING_DIR = REPOSITORY_ROOT / "training"
DEFAULT_CONFIG_PATH = TRAINING_DIR / "configs" / "bookmaker-qlora.toml"
DEFAULT_TEMPLATE_PATH = TRAINING_DIR / "templates" / "Modelfile.tmpl"

COMPUTE_DTYPES = ("bfloat16", "float16")
QUANT_TYPES = ("nf4", "fp4")
LR_SCHEDULERS = ("linear", "cosine", "cosine_with_restarts", "polynomial", "constant")


class ConfigError(ValueError):
    """The config file is missing, unreadable or invalid."""


def _positive(name: str, value: float) -> None:
    if value <= 0:
        raise ConfigError(f"{name} must be greater than 0, got {value}")


@dataclass(frozen=True)
class ModelSettings:
    base_id: str
    max_seq_length: int = 4096
    load_in_4bit: bool = True
    bnb_4bit_quant_type: str = "nf4"
    bnb_4bit_use_double_quant: bool = True
    bnb_4bit_compute_dtype: str = "bfloat16"

    def __post_init__(self) -> None:
        if not self.base_id.strip():
            raise ConfigError("model.base_id must not be empty")
        _positive("model.max_seq_length", self.max_seq_length)
        if self.bnb_4bit_quant_type not in QUANT_TYPES:
            raise ConfigError(f"model.bnb_4bit_quant_type must be one of {QUANT_TYPES}")
        if self.bnb_4bit_compute_dtype not in COMPUTE_DTYPES:
            raise ConfigError(f"model.bnb_4bit_compute_dtype must be one of {COMPUTE_DTYPES}")


@dataclass(frozen=True)
class LoraSettings:
    r: int
    alpha: int
    dropout: float
    target_modules: tuple[str, ...]
    bias: str = "none"

    def __post_init__(self) -> None:
        _positive("lora.r", self.r)
        _positive("lora.alpha", self.alpha)
        if not 0.0 <= self.dropout < 1.0:
            raise ConfigError(f"lora.dropout must be in [0, 1), got {self.dropout}")
        if not self.target_modules or any(not name.strip() for name in self.target_modules):
            raise ConfigError("lora.target_modules must list at least one module name")
        if len(set(self.target_modules)) != len(self.target_modules):
            raise ConfigError("lora.target_modules must not repeat a module name")
        if self.bias not in ("none", "all", "lora_only"):
            raise ConfigError("lora.bias must be none, all or lora_only")


@dataclass(frozen=True)
class TrainingSettings:
    seed: int
    learning_rate: float
    num_train_epochs: float
    max_steps: int
    per_device_train_batch_size: int
    gradient_accumulation_steps: int
    warmup_ratio: float = 0.03
    weight_decay: float = 0.0
    lr_scheduler_type: str = "cosine"
    optim: str = "paged_adamw_8bit"
    logging_steps: int = 10
    save_steps: int = 100
    save_total_limit: int = 2
    gradient_checkpointing: bool = True
    bf16: bool = True

    def __post_init__(self) -> None:
        if self.seed < 0:
            raise ConfigError("training.seed must not be negative")
        _positive("training.learning_rate", self.learning_rate)
        if self.max_steps == 0 or self.max_steps < -1:
            raise ConfigError("training.max_steps must be -1 (use the epochs) or positive")
        if self.max_steps == -1:
            _positive("training.num_train_epochs", self.num_train_epochs)
        _positive("training.per_device_train_batch_size", self.per_device_train_batch_size)
        _positive("training.gradient_accumulation_steps", self.gradient_accumulation_steps)
        if not 0.0 <= self.warmup_ratio < 1.0:
            raise ConfigError("training.warmup_ratio must be in [0, 1)")
        if self.weight_decay < 0:
            raise ConfigError("training.weight_decay must not be negative")
        if self.lr_scheduler_type not in LR_SCHEDULERS:
            raise ConfigError(f"training.lr_scheduler_type must be one of {LR_SCHEDULERS}")
        _positive("training.logging_steps", self.logging_steps)
        _positive("training.save_steps", self.save_steps)
        _positive("training.save_total_limit", self.save_total_limit)

    @property
    def effective_batch_size(self) -> int:
        return self.per_device_train_batch_size * self.gradient_accumulation_steps


@dataclass(frozen=True)
class PathSettings:
    output_dir: Path
    dataset_dir: Path | None = None

    @property
    def checkpoints_dir(self) -> Path:
        return self.output_dir / "checkpoints"

    @property
    def adapter_dir(self) -> Path:
        return self.output_dir / "adapter"

    @property
    def merged_dir(self) -> Path:
        return self.output_dir / "merged"

    @property
    def gguf_dir(self) -> Path:
        return self.output_dir / "gguf"

    @property
    def run_record_path(self) -> Path:
        return self.output_dir / "run-record.json"

    @property
    def modelfile_path(self) -> Path:
        return self.output_dir / "Modelfile"


@dataclass(frozen=True)
class ExportSettings:
    llama_cpp_dir: Path
    quantization: str = "Q4_K_M"
    ollama_tag: str = "sib-bookmaker-ft:v1"
    num_ctx: int = 8192
    temperature: float = 0.0
    template_file: Path | None = None

    def __post_init__(self) -> None:
        if not self.quantization.strip() or " " in self.quantization:
            raise ConfigError("export.quantization must be one word such as Q4_K_M")
        if not self.ollama_tag.strip() or any(c.isspace() for c in self.ollama_tag):
            raise ConfigError("export.ollama_tag must be a tag without spaces")
        _positive("export.num_ctx", self.num_ctx)
        if self.temperature < 0:
            raise ConfigError("export.temperature must not be negative")


@dataclass(frozen=True)
class TrainConfig:
    model: ModelSettings
    lora: LoraSettings
    training: TrainingSettings
    paths: PathSettings
    export: ExportSettings
    # Settings the builder still has to confirm on the laptop (printed in every plan).
    unverified: tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, Any]:
        """A JSON-ready copy for the run record (paths become strings)."""
        return typing.cast("dict[str, Any]", _jsonable(dataclasses.asdict(self)))


def _jsonable(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_jsonable(item) for item in value]
    return value


def _check_type(where: str, value: Any, expected: Any) -> Any:
    """Checks one TOML value against a field annotation and converts it to the field's type."""
    if expected is bool:
        if not isinstance(value, bool):
            raise ConfigError(f"{where} must be true or false")
        return value
    if expected is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(f"{where} must be a whole number")
        return value
    if expected is float:
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ConfigError(f"{where} must be a number")
        return float(value)
    if expected is str:
        if not isinstance(value, str):
            raise ConfigError(f"{where} must be a string")
        return value
    if expected == tuple[str, ...]:
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ConfigError(f"{where} must be a list of strings")
        return tuple(value)
    raise AssertionError(f"unsupported annotation for {where}: {expected}")  # pragma: no cover


def _build[T](cls: type[T], table: Any, name: str) -> T:
    """Builds a settings dataclass from a TOML table: no unknown keys, right types, no gaps."""
    if not isinstance(table, dict):
        raise ConfigError(f"[{name}] is missing or is not a table")
    hints = typing.get_type_hints(cls)
    fields = {f.name: f for f in dataclasses.fields(cls)}  # type: ignore[arg-type]
    unknown = sorted(set(table) - set(fields))
    if unknown:
        raise ConfigError(f"[{name}] has unknown keys: {', '.join(unknown)}")
    values: dict[str, Any] = {}
    for key, item in fields.items():
        if key in table:
            values[key] = _check_type(f"{name}.{key}", table[key], hints[key])
        elif item.default is dataclasses.MISSING and item.default_factory is dataclasses.MISSING:
            raise ConfigError(f"[{name}] needs {key}")
    return cls(**values)


def resolve_path(text: str) -> Path:
    """Expands `~`; relative paths are refused so a run never depends on the working folder."""
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise ConfigError(f"{text!r} must be an absolute path or start with ~")
    return path


def assert_outside_repository(name: str, path: Path) -> None:
    if path.resolve().is_relative_to(REPOSITORY_ROOT):
        raise ConfigError(
            f"{name} ({path}) is inside the repository; weights and checkpoints are never "
            "committed (ADR-0006). Use a folder outside it, such as ~/.should-i-bother/training."
        )


def parse_config(data: dict[str, Any]) -> TrainConfig:
    """Validates a parsed TOML document."""
    unknown = sorted(set(data) - {"unverified", "model", "lora", "training", "paths", "export"})
    if unknown:
        raise ConfigError(f"unknown top-level keys: {', '.join(unknown)}")
    unverified = _check_type("unverified", data.get("unverified", []), tuple[str, ...])

    paths_table = data.get("paths")
    if not isinstance(paths_table, dict):
        raise ConfigError("[paths] is missing or is not a table")
    paths_raw = _build(_RawPaths, paths_table, "paths")
    output_dir = resolve_path(paths_raw.output_dir)
    assert_outside_repository("paths.output_dir", output_dir)
    dataset_dir = resolve_path(paths_raw.dataset_dir) if paths_raw.dataset_dir.strip() else None

    export_table = data.get("export")
    if not isinstance(export_table, dict):
        raise ConfigError("[export] is missing or is not a table")
    export_raw = _build(_RawExport, export_table, "export")
    template_file = (
        resolve_path(export_raw.template_file) if export_raw.template_file.strip() else None
    )

    return TrainConfig(
        model=_build(ModelSettings, data.get("model"), "model"),
        lora=_build(LoraSettings, data.get("lora"), "lora"),
        training=_build(TrainingSettings, data.get("training"), "training"),
        paths=PathSettings(output_dir=output_dir, dataset_dir=dataset_dir),
        export=ExportSettings(
            llama_cpp_dir=resolve_path(export_raw.llama_cpp_dir),
            quantization=export_raw.quantization,
            ollama_tag=export_raw.ollama_tag,
            num_ctx=export_raw.num_ctx,
            temperature=export_raw.temperature,
            template_file=template_file,
        ),
        unverified=unverified,
    )


@dataclass(frozen=True)
class _RawPaths:
    """`[paths]` as written in the file: strings, resolved by `parse_config`."""

    output_dir: str
    dataset_dir: str = ""


@dataclass(frozen=True)
class _RawExport:
    """`[export]` as written in the file: paths are strings until `parse_config` resolves them."""

    llama_cpp_dir: str
    quantization: str = "Q4_K_M"
    ollama_tag: str = "sib-bookmaker-ft:v1"
    num_ctx: int = 8192
    temperature: float = 0.0
    template_file: str = ""


def load_config(path: Path | str = DEFAULT_CONFIG_PATH) -> TrainConfig:
    """Reads and validates a config file; raises `ConfigError` with a one-line reason."""
    config_path = Path(path)
    try:
        with config_path.open("rb") as handle:
            data = tomllib.load(handle)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {config_path}") from None
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"cannot read {config_path}: {error}") from error
    return parse_config(data)
