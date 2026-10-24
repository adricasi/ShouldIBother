"""Shared test helpers: a writable copy of the fixture dataset and a config that stays in tmp."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from training.config import DEFAULT_CONFIG_PATH

REVISION = "0123456789abcdef0123456789abcdef01234567"
FIXTURE_DATASET = Path(__file__).parent / "fixtures" / "dataset"


def copy_dataset(destination: Path) -> Path:
    shutil.copytree(FIXTURE_DATASET, destination)
    return destination


def read_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def rewrite_dataset(
    folder: Path,
    *,
    train: Callable[[list[dict[str, Any]]], list[dict[str, Any]]] | None = None,
    holdout: Callable[[list[dict[str, Any]]], list[dict[str, Any]]] | None = None,
    manifest: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    """Edits a dataset copy and keeps the manifest's row counts and hashes true to the files,
    so a test reaches the check it is about instead of the hash check."""
    meta = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    for split, edit in (("train", train), ("holdout", holdout)):
        path = folder / f"{split}.jsonl"
        rows = read_rows(path)
        if edit is not None:
            rows = edit(rows)
        text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
        path.write_text(text, encoding="utf-8")
        meta["files"][split]["rows"] = len(rows)
        meta["files"][split]["sha256"] = hashlib.sha256(text.encode()).hexdigest()
    if manifest is not None:
        manifest(meta)
    (folder / "manifest.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def write_config(
    folder: Path,
    *,
    output_dir: Path,
    llama_cpp_dir: Path | None = None,
    revision: str = REVISION,
    extra: str = "",
) -> Path:
    """A copy of the committed config with outputs under `folder` (never the user's home)."""
    text = DEFAULT_CONFIG_PATH.read_text(encoding="utf-8")
    text = text.replace(
        'output_dir = "~/.should-i-bother/training/bookmaker-qlora"', f'output_dir = "{output_dir}"'
    )
    text = text.replace('revision = ""', f'revision = "{revision}"')
    if llama_cpp_dir is not None:
        text = text.replace('llama_cpp_dir = "~/llama.cpp"', f'llama_cpp_dir = "{llama_cpp_dir}"')
    path = folder / "config.toml"
    path.write_text(text + extra, encoding="utf-8")
    return path
