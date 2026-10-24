"""Merge the LoRA adapter, convert to GGUF, write an Ollama Modelfile (REQ-019 AC-019.2; T-036).

    PYTHONPATH=src uv run --group train python -m training.merge_and_export --dry-run
    PYTHONPATH=src uv run --group train python -m training.merge_and_export

Steps: (1) merge the adapter into the bf16 base model, (2) convert it with llama.cpp's
`convert_hf_to_gguf.py`, (3) quantize with `llama-quantize`, (4) write the `Modelfile` from
`templates/Modelfile.tmpl`. The last line printed is the `ollama create` command: this script
never runs it, that step is the builder's (the new tag and its digest go into
`config/models.json` as `models["e4b-ft"]`).

`--dry-run` prints every step and the Modelfile without importing torch or touching a file.
Every llama.cpp flag, path and Gemma 4 support claim here is UNVERIFIED until the builder runs it.
"""

from __future__ import annotations

import argparse
import shlex
import string
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

from training.config import (
    DEFAULT_CONFIG_PATH,
    DEFAULT_TEMPLATE_PATH,
    ConfigError,
    TrainConfig,
    assert_outside_repository,
    load_config,
    resolve_path,
)
from training.provenance import environment_info, package_versions, sha256_file, write_json

EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_STEP_FAILED = 3

STAGES = ("all", "merge", "gguf", "modelfile")
# UNVERIFIED: the names of llama.cpp's converter and of the quantizer binary in a CMake build.
CONVERT_SCRIPT = "convert_hf_to_gguf.py"
QUANTIZE_BINARY = Path("build") / "bin" / "llama-quantize"
CONVERT_OUTTYPE = "f16"
TEMPLATE_PLACEHOLDER = (
    "# TODO(builder) UNVERIFIED: no TEMPLATE / RENDERER / PARSER lines (export.template_file is\n"
    "# empty). Copy them from `ollama show --modelfile <base tag>` if the model does not answer\n"
    "# in the chat format Ollama infers from the GGUF."
)


class ExportError(RuntimeError):
    """A prerequisite of an export step is missing or a step failed."""


@dataclass(frozen=True)
class ExportPaths:
    adapter_dir: Path
    merged_dir: Path
    f16_gguf: Path
    quantized_gguf: Path
    modelfile: Path
    record: Path


@dataclass(frozen=True)
class Step:
    description: str
    argv: tuple[str, ...]

    def shell(self) -> str:
        return shlex.join(self.argv)


def export_paths(config: TrainConfig) -> ExportPaths:
    out = config.paths
    stem = config.export.ollama_tag.replace(":", "-").replace("/", "-")
    quantization = config.export.quantization.lower()
    return ExportPaths(
        adapter_dir=out.adapter_dir,
        merged_dir=out.merged_dir,
        f16_gguf=out.gguf_dir / f"{stem}-{CONVERT_OUTTYPE}.gguf",
        quantized_gguf=out.gguf_dir / f"{stem}-{quantization}.gguf",
        modelfile=out.modelfile_path,
        record=out.output_dir / "export-record.json",
    )


def gguf_steps(config: TrainConfig, paths: ExportPaths) -> list[Step]:
    """The llama.cpp commands, as argument lists (never a shell string)."""
    llama = config.export.llama_cpp_dir
    return [
        Step(
            "convert the merged model to a GGUF",
            (
                sys.executable,
                str(llama / CONVERT_SCRIPT),
                str(paths.merged_dir),
                "--outfile",
                str(paths.f16_gguf),
                "--outtype",
                CONVERT_OUTTYPE,
            ),
        ),
        Step(
            f"quantize the GGUF to {config.export.quantization}",
            (
                str(llama / QUANTIZE_BINARY),
                str(paths.f16_gguf),
                str(paths.quantized_gguf),
                config.export.quantization,
            ),
        ),
    ]


def template_block(config: TrainConfig) -> str:
    """The TEMPLATE lines copied from the base model, or a visible placeholder."""
    source = config.export.template_file
    if source is None:
        return TEMPLATE_PLACEHOLDER
    try:
        text = source.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ExportError(f"cannot read export.template_file {source}: {error.strerror}") from error
    if not text:
        raise ExportError(f"export.template_file {source} is empty")
    return text


def render_modelfile(
    template_text: str, config: TrainConfig, gguf: Path, template_lines: str
) -> str:
    """Fills the Modelfile template; the temperature and seed are fixed for reproducibility."""
    return string.Template(template_text).substitute(
        gguf=str(gguf),
        temperature=config.export.temperature,
        seed=config.training.seed,
        num_ctx=config.export.num_ctx,
        template_block=template_lines,
    )


def ollama_create_command(config: TrainConfig, modelfile: Path) -> str:
    return shlex.join(["ollama", "create", config.export.ollama_tag, "-f", str(modelfile)])


def merge_adapter(config: TrainConfig, paths: ExportPaths) -> None:
    """Merges the adapter into the bf16 base model on the CPU and saves it.

    UNVERIFIED: the memory needed (the E4B weights in bf16 are several GB), whether
    AutoModelForCausalLM is the right class for Gemma 4, and that merging an adapter trained on
    the 4-bit base into the bf16 base gives the same answers (the usual practice).
    """
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    model = AutoModelForCausalLM.from_pretrained(
        config.model.base_id, dtype=torch.bfloat16, device_map="cpu"
    )
    merged = PeftModel.from_pretrained(model, str(paths.adapter_dir)).merge_and_unload()
    paths.merged_dir.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(paths.merged_dir), safe_serialization=True)
    AutoTokenizer.from_pretrained(str(paths.adapter_dir)).save_pretrained(str(paths.merged_dir))


def _require(path: Path, what: str) -> None:
    if not path.exists():
        raise ExportError(f"{what} not found: {path}")


def _run_step(step: Step) -> None:
    result = subprocess.run(step.argv, check=False)
    if result.returncode != 0:
        raise ExportError(f"{step.description} failed (exit {result.returncode}): {step.shell()}")


def run_export(
    config: TrainConfig,
    paths: ExportPaths,
    stage: str,
    *,
    template_text: str,
    merger: Callable[[TrainConfig, ExportPaths], None] = merge_adapter,
    runner: Callable[[Step], None] = _run_step,
    echo: Callable[[str], None] = print,
) -> None:
    """Runs the chosen stages; raises `ExportError` on a missing prerequisite or a failed step."""
    if stage in ("all", "merge"):
        _require(paths.adapter_dir / "adapter_config.json", "the adapter (run training first)")
        echo(f"[1/4] merging {paths.adapter_dir} into {config.model.base_id} ...")
        merger(config, paths)
    if stage in ("all", "gguf"):
        _require(paths.merged_dir / "config.json", "the merged model (run the merge step first)")
        llama = config.export.llama_cpp_dir
        _require(llama / CONVERT_SCRIPT, "llama.cpp converter")
        _require(llama / QUANTIZE_BINARY, "llama.cpp quantizer (build llama.cpp with CMake)")
        paths.f16_gguf.parent.mkdir(parents=True, exist_ok=True)
        for number, step in enumerate(gguf_steps(config, paths), start=2):
            echo(f"[{number}/4] {step.description} ...")
            runner(step)
        _require(paths.quantized_gguf, "the quantized GGUF")
    if stage in ("all", "modelfile"):
        _require(paths.quantized_gguf, "the quantized GGUF (run the gguf step first)")
        echo("[4/4] writing the Modelfile ...")
        modelfile = render_modelfile(
            template_text, config, paths.quantized_gguf, template_block(config)
        )
        paths.modelfile.write_text(modelfile, encoding="utf-8")
        write_json(
            paths.record,
            {
                "base_model": config.model.base_id,
                "quantization": config.export.quantization,
                "gguf": str(paths.quantized_gguf),
                "gguf_sha256": sha256_file(paths.quantized_gguf),
                "modelfile": str(paths.modelfile),
                "ollama_tag": config.export.ollama_tag,
                "seed": config.training.seed,
                "packages": package_versions(),
                "environment": environment_info(),
            },
        )


def describe_plan(config: TrainConfig, paths: ExportPaths, stage: str, template_text: str) -> str:
    lines = ["Export plan (dry run)", f"  stage          {stage}"]
    if stage in ("all", "merge"):
        lines.append(
            f"  1. merge       {paths.adapter_dir} + {config.model.base_id} -> {paths.merged_dir}"
        )
    if stage in ("all", "gguf"):
        for number, step in enumerate(gguf_steps(config, paths), start=2):
            lines.append(f"  {number}. {step.description}\n       {step.shell()}")
    if stage in ("all", "modelfile"):
        try:
            block = template_block(config)
        except ExportError as error:
            block = f"# {error}"
        lines.append(f"  4. Modelfile -> {paths.modelfile}")
        lines.extend(
            "       | " + line
            for line in render_modelfile(
                template_text, config, paths.quantized_gguf, block
            ).splitlines()
        )
    lines.append("Then, by the builder (this script never runs it):")
    lines.append(f"  {ollama_create_command(config, paths.modelfile)}")
    if config.unverified:
        lines.append("UNVERIFIED, builder to confirm: " + "; ".join(config.unverified))
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.merge_and_export",
        description="Merge the adapter, convert to GGUF and write an Ollama Modelfile.",
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--output-dir", type=Path, help="overrides paths.output_dir")
    parser.add_argument("--llama-cpp-dir", type=Path, help="overrides export.llama_cpp_dir")
    parser.add_argument("--stage", choices=STAGES, default="all")
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE_PATH)
    parser.add_argument(
        "--dry-run", action="store_true", help="print the steps and the Modelfile, change nothing"
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    merger: Callable[[TrainConfig, ExportPaths], None] = merge_adapter,
    runner: Callable[[Step], None] = _run_step,
    echo: Callable[[str], None] = print,
) -> int:
    args = _parser().parse_args(list(sys.argv[1:] if argv is None else argv))
    try:
        config = load_config(args.config)
        if args.output_dir is not None:
            output_dir = args.output_dir.expanduser().resolve()
            assert_outside_repository("--output-dir", output_dir)
            config = replace(config, paths=replace(config.paths, output_dir=output_dir))
        if args.llama_cpp_dir is not None:
            llama = resolve_path(str(args.llama_cpp_dir.expanduser()))
            config = replace(config, export=replace(config.export, llama_cpp_dir=llama))
        try:
            template_text = args.template.read_text(encoding="utf-8")
        except OSError as error:
            raise ConfigError(f"cannot read the Modelfile template {args.template}") from error
        paths = export_paths(config)
    except ConfigError as error:
        echo(f"error: {error}")
        return EXIT_BAD_INPUT

    if args.dry_run:
        echo(describe_plan(config, paths, args.stage, template_text))
        echo("Dry run: nothing was written and no model was loaded.")
        return EXIT_OK
    try:
        run_export(
            config,
            paths,
            args.stage,
            template_text=template_text,
            merger=merger,
            runner=runner,
            echo=echo,
        )
    except ExportError as error:
        echo(f"error: {error}")
        return EXIT_STEP_FAILED
    if args.stage in ("all", "modelfile"):
        echo("Done. The builder imports the model into Ollama with:")
        echo(f"  {ollama_create_command(config, paths.modelfile)}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
