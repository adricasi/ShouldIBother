"""Stand-ins for torch, transformers, peft, trl and datasets, so the code that drives them can be
tested for what it asks of them (arguments, order) without installing a single ML library."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import pytest


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

    def save_pretrained(self, path: str) -> None:
        Path(path).mkdir(parents=True, exist_ok=True)
        (Path(path) / "tokenizer.json").write_text("{}")


class FakeModel:
    def __init__(self, commit: str | None) -> None:
        self.config = types.SimpleNamespace(_commit_hash=commit)

    def save_pretrained(self, path: str, **kwargs: Any) -> None:
        Path(path).mkdir(parents=True, exist_ok=True)
        (Path(path) / "config.json").write_text("{}")


class FakeML:
    """Records every call the training and export code makes into the fake libraries."""

    def __init__(self, commit: str | None) -> None:
        self.commit = commit
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.seeds: list[tuple[int, dict[str, Any]]] = []
        self.deterministic: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def record(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.calls.append((name, args, kwargs))

    def kwargs_of(self, name: str) -> list[dict[str, Any]]:
        return [kwargs for call, _, kwargs in self.calls if call == name]


def install_fake_ml(
    monkeypatch: pytest.MonkeyPatch, *, commit: str | None, with_deterministic_flag: bool = True
) -> FakeML:
    fake = FakeML(commit)

    torch = types.ModuleType("torch")
    torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    torch.float16 = "float16"  # type: ignore[attr-defined]

    def use_deterministic_algorithms(*args: Any, **kwargs: Any) -> None:
        fake.deterministic.append((args, kwargs))

    torch.use_deterministic_algorithms = use_deterministic_algorithms  # type: ignore[attr-defined]

    transformers = types.ModuleType("transformers")
    if with_deterministic_flag:

        def set_seed(seed: int, deterministic: bool = False) -> None:
            fake.seeds.append((seed, {"deterministic": deterministic}))

    else:

        def set_seed(seed: int) -> None:  # type: ignore[misc]
            fake.seeds.append((seed, {}))

    class AutoTokenizer:
        @staticmethod
        def from_pretrained(name: str, **kwargs: Any) -> FakeTokenizer:
            fake.record("AutoTokenizer", name, **kwargs)
            return FakeTokenizer()

    class AutoModelForCausalLM:
        @staticmethod
        def from_pretrained(name: str, **kwargs: Any) -> FakeModel:
            fake.record("AutoModelForCausalLM", name, **kwargs)
            return FakeModel(fake.commit)

    class BitsAndBytesConfig:
        def __init__(self, **kwargs: Any) -> None:
            fake.record("BitsAndBytesConfig", **kwargs)

    transformers.set_seed = set_seed  # type: ignore[attr-defined]
    transformers.AutoTokenizer = AutoTokenizer  # type: ignore[attr-defined]
    transformers.AutoModelForCausalLM = AutoModelForCausalLM  # type: ignore[attr-defined]
    transformers.BitsAndBytesConfig = BitsAndBytesConfig  # type: ignore[attr-defined]

    peft = types.ModuleType("peft")

    class LoraConfig:
        def __init__(self, **kwargs: Any) -> None:
            fake.record("LoraConfig", **kwargs)

    class Adapted:
        def merge_and_unload(self) -> FakeModel:
            return FakeModel(fake.commit)

    class PeftModel:
        @staticmethod
        def from_pretrained(model: Any, path: str) -> Adapted:
            fake.record("PeftModel", path)
            return Adapted()

    peft.LoraConfig = LoraConfig  # type: ignore[attr-defined]
    peft.PeftModel = PeftModel  # type: ignore[attr-defined]

    trl = types.ModuleType("trl")

    class SFTConfig:
        def __init__(self, **kwargs: Any) -> None:
            fake.record("SFTConfig", **kwargs)

    class SFTTrainer:
        def __init__(self, **kwargs: Any) -> None:
            fake.record("SFTTrainer", **{k: v for k, v in kwargs.items() if k != "model"})
            self.model = FakeModel(fake.commit)
            self.state = types.SimpleNamespace(global_step=4)

        def train(self, resume_from_checkpoint: Any = None) -> Any:
            fake.record("train", resume_from_checkpoint=resume_from_checkpoint)
            return types.SimpleNamespace(metrics={"train_loss": 1.0})

    trl.SFTConfig = SFTConfig  # type: ignore[attr-defined]
    trl.SFTTrainer = SFTTrainer  # type: ignore[attr-defined]

    datasets = types.ModuleType("datasets")

    class Dataset:
        @staticmethod
        def from_list(rows: list[Any]) -> list[Any]:
            fake.record("Dataset.from_list", len(rows))
            return rows

    datasets.Dataset = Dataset  # type: ignore[attr-defined]

    for module in (torch, transformers, peft, trl, datasets):
        monkeypatch.setitem(sys.modules, module.__name__, module)
    return fake
