"""QLoRA fine-tune of the bookmaker with TRL's SFTTrainer and PEFT (REQ-019, NFR-012; T-036).

    cd training && PYTHONPATH=src uv run --group train python -m training.train \\
        --dataset ~/.should-i-bother/datasets/<snapshot>            # the real run (T-012)
    cd training && PYTHONPATH=src uv run python -m training.train --dataset <dir> --dry-run

`--dry-run` loads and checks the config and the dataset, prints the plan and exits; it imports
neither torch nor transformers, so CI and a laptop without the `train` group can run it. The real
run refuses to start while Ollama holds a model in memory (one GPU user at a time).

Everything that touches torch, transformers, trl or peft is UNVERIFIED: it was written from their
documentation without a GPU. The builder checks it in T-012 (see training/README.md).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

from training.config import (
    DEFAULT_CONFIG_PATH,
    ConfigError,
    TrainConfig,
    assert_outside_repository,
    load_config,
)
from training.dataset import (
    MANIFEST_FILE,
    Dataset,
    DatasetError,
    load_dataset,
    render_example,
    training_examples,
)
from training.ollama import (
    GpuBusyError,
    OllamaError,
    OllamaProbe,
    OllamaStatus,
    ensure_gpu_free,
    probe_ollama,
)
from training.provenance import environment_info, package_versions, write_json

EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_GPU_BUSY = 3
EXIT_RUN_EXISTS = 4

# JSON, ids and numbers tokenize at roughly three characters per token; a safe over-estimate.
CHARS_PER_TOKEN = 3.0


@dataclass(frozen=True)
class TrainPlan:
    dataset_dir: str
    prompt_version: str
    manifest_sha256: str
    train_rows: int
    holdout_rows_not_used: int
    effective_batch_size: int
    steps_per_epoch: int
    total_steps: int
    longest_example_chars: int
    estimated_longest_tokens: int
    max_seq_length: int

    @property
    def fits_sequence_length(self) -> bool:
        return self.estimated_longest_tokens <= self.max_seq_length


def _example_chars(example: dict[str, Any]) -> int:
    messages = [*example["prompt"], *example["completion"]]
    return sum(len(json.dumps(message, ensure_ascii=False)) for message in messages) + len(
        json.dumps(example["tools"], ensure_ascii=False)
    )


def build_plan(config: TrainConfig, dataset: Dataset) -> TrainPlan:
    examples = training_examples(dataset)
    batch = config.training.effective_batch_size
    per_epoch = max(1, math.ceil(len(examples) / batch))
    total = (
        config.training.max_steps
        if config.training.max_steps > 0
        else math.ceil(config.training.num_train_epochs * per_epoch)
    )
    longest = max((_example_chars(example) for example in examples), default=0)
    return TrainPlan(
        dataset_dir=str(dataset.directory),
        prompt_version=dataset.prompt_version,
        manifest_sha256=dataset.manifest_sha256,
        train_rows=len(examples),
        holdout_rows_not_used=len(dataset.holdout),
        effective_batch_size=batch,
        steps_per_epoch=per_epoch,
        total_steps=total,
        longest_example_chars=longest,
        estimated_longest_tokens=math.ceil(longest / CHARS_PER_TOKEN),
        max_seq_length=config.model.max_seq_length,
    )


def format_plan(
    config: TrainConfig,
    plan: TrainPlan,
    status: OllamaStatus,
    output_dir: Path,
    *,
    dry_run: bool,
) -> str:
    precision = (
        f"4-bit {config.model.bnb_4bit_quant_type}"
        if config.model.load_in_4bit
        else "full precision"
    )
    lines = [
        "Training plan (dry run)" if dry_run else "Training plan",
        f"  base model     {config.model.base_id}  ({precision})",
        f"  LoRA           r={config.lora.r} alpha={config.lora.alpha} "
        f"dropout={config.lora.dropout} on {', '.join(config.lora.target_modules)}",
        f"  dataset        {plan.dataset_dir}",
        f"                 prompt {plan.prompt_version}, manifest sha256 {plan.manifest_sha256}",
        f"  rows           {plan.train_rows} training, {plan.holdout_rows_not_used} hold-out "
        "(hold-out is never trained on)",
        f"  schedule       batch {config.training.per_device_train_batch_size} x "
        f"accumulation {config.training.gradient_accumulation_steps} = "
        f"{plan.effective_batch_size}, {plan.steps_per_epoch} steps per epoch, "
        f"{plan.total_steps} steps in total, lr {config.training.learning_rate}",
        f"  seed           {config.training.seed} (Python, NumPy, PyTorch, data order, trainer)",
        f"  sequence       longest example ~{plan.estimated_longest_tokens} tokens "
        f"(estimate) of {plan.max_seq_length}",
        f"  output         {output_dir}",
    ]
    if not plan.fits_sequence_length:
        lines.append(
            "  WARNING        the longest example may not fit max_seq_length: the answer at its "
            "end would be cut off. Raise model.max_seq_length or shorten the prompt."
        )
    if status.loaded_models:
        lines.append(
            f"  ollama         WOULD REFUSE TO START: {', '.join(status.loaded_models)} loaded "
            "(run `ollama stop` first)"
        )
    elif status.reachable:
        lines.append("  ollama         running, no model loaded")
    else:
        lines.append("  ollama         not running")
    if config.unverified:
        lines.append("  UNVERIFIED, builder to confirm:")
        lines.extend(f"    - {item}" for item in config.unverified)
    return "\n".join(lines)


def seed_everything(seed: int) -> None:
    """Seeds Python, NumPy and PyTorch (CPU and CUDA) with one value (NFR-012).

    `PYTHONHASHSEED` only affects processes started afterwards (set it in the shell for the run
    itself); it is recorded in the environment so child processes inherit it.
    """
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    from transformers import set_seed  # heavy: only the real run gets here

    set_seed(seed)


def build_run_record(
    config: TrainConfig, dataset: Dataset, plan: TrainPlan, argv: Sequence[str]
) -> dict[str, Any]:
    manifest = dataset.manifest
    return {
        "kind": "bookmaker-qlora-training",
        "command": list(argv),
        "config": config.as_dict(),
        "seeds": {"seed": config.training.seed, "data_seed": config.training.seed},
        "dataset": {
            "directory": str(dataset.directory),
            "manifest_sha256": dataset.manifest_sha256,
            "file_sha256": dataset.file_sha256,
            "prompt_version": dataset.prompt_version,
            "bookmaker_prompt_sha256": manifest["bookmaker_prompt"].get("sha256"),
            "rules_json_sha256": manifest["rules_json_sha256"],
            "snapshot_end_date": manifest["snapshot"]["end_date"],
            "rows": {"train": len(dataset.train), "holdout": len(dataset.holdout)},
        },
        "plan": asdict(plan),
        "packages": package_versions(),
        "environment": environment_info(),
        "unverified": list(config.unverified),
    }


def run_training(config: TrainConfig, dataset: Dataset, output_dir: Path, *, resume: bool) -> None:
    """The QLoRA run itself. UNVERIFIED: written from the TRL, PEFT and transformers docs."""
    import torch
    from datasets import Dataset as HfDataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    model_cfg, lora_cfg, train_cfg = config.model, config.lora, config.training
    seed_everything(train_cfg.seed)

    tokenizer = AutoTokenizer.from_pretrained(model_cfg.base_id)
    rendered = [render_example(example, tokenizer) for example in training_examples(dataset)]
    # Look at this file before trusting the run: the prompt, then the part the loss covers.
    (output_dir / "first-example.txt").write_text(
        rendered[0]["prompt"] + "\n<<<<<< COMPLETION (loss) >>>>>>\n" + rendered[0]["completion"],
        encoding="utf-8",
    )
    train_dataset = HfDataset.from_list(rendered)

    compute_dtype = getattr(torch, model_cfg.bnb_4bit_compute_dtype)
    quantization = (
        BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type=model_cfg.bnb_4bit_quant_type,
            bnb_4bit_use_double_quant=model_cfg.bnb_4bit_use_double_quant,
            bnb_4bit_compute_dtype=compute_dtype,
        )
        if model_cfg.load_in_4bit
        else None
    )
    # UNVERIFIED: Gemma 4 E4B is a multimodal model; AutoModelForCausalLM may load only the
    # text decoder or may need another Auto class.
    model = AutoModelForCausalLM.from_pretrained(
        model_cfg.base_id,
        quantization_config=quantization,
        device_map={"": 0},
        dtype=compute_dtype,
    )
    peft_config = LoraConfig(
        r=lora_cfg.r,
        lora_alpha=lora_cfg.alpha,
        lora_dropout=lora_cfg.dropout,
        target_modules=list(lora_cfg.target_modules),
        bias=lora_cfg.bias,
        task_type="CAUSAL_LM",
    )
    args = SFTConfig(
        output_dir=str(config.paths.checkpoints_dir),
        seed=train_cfg.seed,
        data_seed=train_cfg.seed,
        num_train_epochs=train_cfg.num_train_epochs,
        max_steps=train_cfg.max_steps,
        per_device_train_batch_size=train_cfg.per_device_train_batch_size,
        gradient_accumulation_steps=train_cfg.gradient_accumulation_steps,
        learning_rate=train_cfg.learning_rate,
        lr_scheduler_type=train_cfg.lr_scheduler_type,
        warmup_ratio=train_cfg.warmup_ratio,
        weight_decay=train_cfg.weight_decay,
        optim=train_cfg.optim,
        logging_steps=train_cfg.logging_steps,
        save_strategy="steps",
        save_steps=train_cfg.save_steps,
        save_total_limit=train_cfg.save_total_limit,
        gradient_checkpointing=train_cfg.gradient_checkpointing,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        bf16=train_cfg.bf16,
        max_length=model_cfg.max_seq_length,
        # Prompt/completion text: the loss covers the answer only, not the prompt.
        completion_only_loss=True,
        packing=False,
        report_to="none",
    )
    trainer = SFTTrainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        processing_class=tokenizer,
        peft_config=peft_config,
    )
    result = trainer.train(resume_from_checkpoint=True if resume else None)
    trainer.model.save_pretrained(str(config.paths.adapter_dir))
    tokenizer.save_pretrained(str(config.paths.adapter_dir))
    write_json(
        output_dir / "result.json",
        {
            "metrics": {k: v for k, v in result.metrics.items() if isinstance(v, int | float)},
            "global_step": trainer.state.global_step,
            "adapter_dir": str(config.paths.adapter_dir),
            "packages": package_versions(),
        },
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m training.train",
        description="QLoRA fine-tune of the Should I Bother? bookmaker (REQ-019).",
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument(
        "--dataset",
        type=Path,
        help="folder written by `sib dataset` (train.jsonl, holdout.jsonl, manifest.json)",
    )
    parser.add_argument("--output-dir", type=Path, help="overrides paths.output_dir")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate the config and the dataset, print the plan, import no ML library",
    )
    parser.add_argument(
        "--resume", action="store_true", help="continue from the last checkpoint of this output"
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    ollama_probe: OllamaProbe = probe_ollama,
    trainer: Callable[..., None] = run_training,
    echo: Callable[[str], None] = print,
) -> int:
    """Entry point. `ollama_probe` and `trainer` are injectable so tests need no Ollama or GPU."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    args = _parser().parse_args(arguments)
    try:
        config = load_config(args.config)
        if args.output_dir is not None:
            config = _with_output_dir(config, args.output_dir)
        dataset_dir = args.dataset or config.paths.dataset_dir
        if dataset_dir is None:
            raise ConfigError("no dataset: pass --dataset <folder> or set paths.dataset_dir")
        dataset = load_dataset(dataset_dir)
        plan = build_plan(config, dataset)
    except (ConfigError, DatasetError) as error:
        echo(f"error: {error}")
        return EXIT_BAD_INPUT

    output_dir = config.paths.output_dir
    probe_error: OllamaError | None = None
    try:
        status = ollama_probe()
    except OllamaError as error:
        status, probe_error = OllamaStatus(reachable=False), error

    if args.dry_run:
        echo(format_plan(config, plan, status, output_dir, dry_run=True))
        if probe_error is not None:
            echo(f"  ollama         could not be checked: {probe_error}")
        echo("Dry run: nothing was written and no model was loaded.")
        return EXIT_OK

    if probe_error is not None:
        echo(f"error: cannot tell whether Ollama holds a model, so not starting: {probe_error}")
        return EXIT_GPU_BUSY
    try:
        ensure_gpu_free(status)
    except GpuBusyError as error:
        echo(f"error: {error}")
        return EXIT_GPU_BUSY
    if config.paths.run_record_path.exists() and not args.resume:
        echo(
            f"error: {config.paths.run_record_path} exists; pass --resume to continue that run "
            "or choose another --output-dir"
        )
        return EXIT_RUN_EXISTS

    echo(format_plan(config, plan, status, output_dir, dry_run=False))
    output_dir.mkdir(parents=True, exist_ok=True)
    # Written before the first step, so even a run that dies leaves what it was started with.
    write_json(config.paths.run_record_path, build_run_record(config, dataset, plan, arguments))
    shutil.copyfile(dataset.directory / MANIFEST_FILE, output_dir / "dataset-manifest.json")
    trainer(config, dataset, output_dir, resume=args.resume)
    echo(
        f"Adapter saved to {config.paths.adapter_dir}. Next: merge_and_export (training/README.md)."
    )
    return EXIT_OK


def _with_output_dir(config: TrainConfig, output_dir: Path) -> TrainConfig:
    resolved = output_dir.expanduser().resolve()
    assert_outside_repository("--output-dir", resolved)
    return replace(config, paths=replace(config.paths, output_dir=resolved))


if __name__ == "__main__":
    raise SystemExit(main())
