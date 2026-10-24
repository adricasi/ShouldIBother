"""What a run records so it can be repeated and audited (NFR-012): versions, hashes, seeds."""

from __future__ import annotations

import hashlib
import json
import platform
import sys
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any

TRACKED_PACKAGES = (
    "torch",
    "transformers",
    "trl",
    "peft",
    "bitsandbytes",
    "accelerate",
    "datasets",
    "numpy",
    "gguf",
    "sentencepiece",
)


def package_versions(names: tuple[str, ...] = TRACKED_PACKAGES) -> dict[str, str]:
    """Installed version of each package, or `not installed` (the dry run installs none)."""
    versions: dict[str, str] = {}
    for name in names:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = "not installed"
    return versions


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def environment_info() -> dict[str, str]:
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
    }


def write_json(path: Path, value: Any) -> None:
    """Sorted keys and a final newline: the same run gives the same bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    """Reads a JSON object written by `write_json`; raises `ValueError` if it is not one."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def update_record(
    path: Path, *, event: dict[str, Any] | None = None, fields: dict[str, Any] | None = None
) -> None:
    """Merges `fields` into a record and appends `event` to its `events` list, with the time.

    Events are only ever appended, so a resumed run keeps the history of the run before it.
    """
    record = read_json(path)
    record.update(fields or {})
    if event is not None:
        events = record.setdefault("events", [])
        events.append({"at": datetime.now(UTC).isoformat(timespec="seconds"), **event})
    write_json(path, record)
