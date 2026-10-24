# Fine-tuning the bookmaker (`training/`)

QLoRA fine-tune of the Gemma 4 E4B bookmaker on the dataset `sib dataset` builds (REQ-019, ADR-0006).
Python 3.12 and [uv](https://docs.astral.sh/uv/) only; it runs on the builder's GPU, never in CI.

These scripts were written (T-036) without a GPU, a Hugging Face login or a Gemma 4 download. Every
line below marked **UNVERIFIED** is the builder's to confirm in T-012. CI (`ruff`, `pytest`) tests
the config, the dataset loading and the dry runs against a tiny synthetic dataset only.

| Module | What it does |
|---|---|
| `configs/bookmaker-qlora.toml` | base model, LoRA, hyper-parameters, seed, output folder, export settings |
| `training.config` | loads and validates that file (unknown keys, types, ranges, outputs outside the repo) |
| `training.dataset` | loads `train.jsonl`, `holdout.jsonl`, `manifest.json`; checks hashes and the row format; refuses any hold-out row in training |
| `training.train` | QLoRA with TRL `SFTTrainer` + PEFT, 4-bit bitsandbytes; `--dry-run` prints the plan |
| `training.merge_and_export` | merge the adapter, GGUF conversion with llama.cpp, quantize, write the `Modelfile`; `--dry-run` |
| `training.eval_holdout` | asks the imported model 20 hold-out prompts and counts valid bookmaker answers (AC-019.2) |

Run the modules from this folder with `PYTHONPATH=src` (the project is not installed as a package).

## Builder steps (T-012)

Place the evening's bets first. From the repository root unless stated.

1. **Free the GPU.** `ollama stop <model>` for every model in `ollama ps`. The app shows Gemma as
   offline overnight and settlements wait (AC-008.8); that is intended. Training refuses to start
   while Ollama has a model loaded (`GET http://127.0.0.1:11434/api/ps`); a daemon with nothing
   loaded is fine.
2. **Snapshot.** `npm run sib -- snapshot` (needs the network; Open-Meteo).
3. **Dataset.** `npm run sib -- dataset --prompt-version N` with the frozen `bookmaker.vN`
   (T-010). Output: `~/.should-i-bother/datasets/<snapshot>/{train,holdout}.jsonl` and
   `manifest.json`. Read the manifest: prompt version, rules hash, snapshot end date, rows per
   chore and band.
4. **Install the training dependencies** (large: PyTorch with CUDA).
   `cd training && uv sync --group train`. They are pinned in `uv.lock`; plain `uv sync` (what CI
   does) installs neither them nor the model. **UNVERIFIED:** that these pins, in particular
   `transformers 5.x` and `trl 1.x`, load Gemma 4 E4B and work with the bitsandbytes build for your
   CUDA driver under WSL2.
5. **Check the config.** Open `configs/bookmaker-qlora.toml` and confirm every entry listed under
   `unverified`, then delete the entry:
   - `model.base_id`: the Hugging Face id of Gemma 4 E4B instruct (a guess by analogy with Gemma 3n;
     accept the licence on the model card and log in to Hugging Face first).
   - `model.revision`: pin the base model to a full 40-character commit hash (model page, Files
     and versions). A real run and a real merge refuse while it is empty; both pass it to every
     `from_pretrained` with `trust_remote_code=False` and log the commit that was loaded.
   - `model.max_seq_length`: the plan prints the longest example's estimated tokens. If the
     estimate exceeds it, the answer at the end of that example would be cut off.
   - `lora.target_modules`: the usual projection names; confirm against `print(model)`.
   - the hyper-parameters (never run; sized for an 8 GB card, batch 1 with 16 accumulation steps).
6. **Dry run.**
   ```bash
   cd training
   PYTHONPATH=src uv run python -m training.train \
     --dataset ~/.should-i-bother/datasets/<snapshot> --dry-run
   ```
   Prints the plan (steps, seed, manifest hash, UNVERIFIED list, Ollama state) and imports no ML
   library.
7. **Train** (unattended; `--resume` continues from the last checkpoint after a crash).
   ```bash
   PYTHONPATH=src uv run --group train python -m training.train \
     --dataset ~/.should-i-bother/datasets/<snapshot>
   ```
   **Double BOS check (T-012 checklist).** Before leaving it running, look at the first example's
   token ids: the rendered prompt already starts with the BOS token, and TRL tokenizes it without
   adding special tokens, so BOS must appear exactly once at the start.
   ```bash
   PYTHONPATH=src uv run --group train python - <<'PY'
   from transformers import AutoTokenizer
   from training.config import load_config
   m = load_config().model
   tok = AutoTokenizer.from_pretrained(m.base_id, revision=m.revision, trust_remote_code=False)
   text = open("<output_dir>/first-example.txt", encoding="utf-8").read().split("\n<<<<<< COMPLETION")[0]
   ids = tok(text, add_special_tokens=False)["input_ids"]
   print(ids[:6], "BOS id:", tok.bos_token_id, "count:", ids.count(tok.bos_token_id))
   PY
   ```
   Two BOS ids in a row at the start means the template and the tokenizer both add one: fix it
   (for example by stripping the BOS from the rendered prompt) before training.

   Look at `<output_dir>/first-example.txt` early: it is the first rendered example, the prompt and
   then the part the loss covers (it must be exactly the answer JSON and the end-of-turn marker).
   The run folder (default `~/.should-i-bother/training/bookmaker-qlora/`, outside the repo) gets
   `run-record.json` (config and its training hash, dataset manifest hash and file hashes, seeds,
   package versions, Python and platform, the pinned and the resolved base-model commit; written
   before the first step, with an append-only `events` list), a copy of the manifest,
   `checkpoints/`, `adapter/` and `result.json`. `--resume` continues only if the dataset manifest
   hash and the model, LoRA and training settings equal the record's (exit 5 otherwise) and appends
   a `resumed` event instead of rewriting the record.
8. **Merge and export.**
   ```bash
   PYTHONPATH=src uv run --group train python -m training.merge_and_export --dry-run   # read it
   PYTHONPATH=src uv run --group train python -m training.merge_and_export
   ```
   It needs a built llama.cpp (`export.llama_cpp_dir`, default `~/llama.cpp`, built with CMake)
   and the converter's own Python requirements in the same environment
   (`uv pip install -r ~/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt` if the
   converter complains). It runs, in order: merge on the CPU into `merged/`;
   `convert_hf_to_gguf.py <merged> --outfile <f16.gguf> --outtype f16`;
   `llama-quantize <f16.gguf> <q4_k_m.gguf> Q4_K_M`; then writes `Modelfile` from
   `templates/Modelfile.tmpl` and `export-record.json` (the GGUF's sha256, the base-model commit, the dataset manifest hash and
   the run record's sha256, so the model links back to its training run). `--stage
   merge|gguf|modelfile` runs one part. **UNVERIFIED:** that llama.cpp supports Gemma 4, the exact
   flags and binary path, the memory the CPU merge needs, and that an adapter trained on the 4-bit
   base merges cleanly into the bf16 base.
9. **Import into Ollama** (the scripts never run this; it prints the command):
   ```bash
   ollama create sib-bookmaker-ft:v1 -f ~/.should-i-bother/training/bookmaker-qlora/Modelfile
   ```
   **UNVERIFIED:** the chat template. A GGUF imported with a bare `FROM` may get a default
   template that does not match the one the model was trained with, including tool calls. If the
   answers are poor, copy the `TEMPLATE` (and `RENDERER` / `PARSER`, if your Ollama has them)
   lines from `ollama show --modelfile <base tag>` into a file, set `export.template_file` to it,
   re-run `--stage modelfile`, and `ollama create` again.
10. **Smoke test: 20 hold-out prompts, at least 19 valid** (AC-019.2, the T-012 Done-when). Every
    prompt is asked twice, with the JSON schema as `format` (as the live app does) and without;
    both rates are reported and the **unconstrained** one is the gate.
    ```bash
    PYTHONPATH=src uv run python -m training.eval_holdout \
      --dataset ~/.should-i-bother/datasets/<snapshot> --model sib-bookmaker-ft:v1 \
      --report ~/.should-i-bother/training/bookmaker-qlora/eval-holdout.json
    ```
    Exit code 1 means fewer than 19 unconstrained answers were valid. This is not the evaluation of the model: that is T-014.
11. **Register the model.** In `config/models.json` set `models["e4b-ft"]` to
    `{tag: "sib-bookmaker-ft:v1", quantization: "Q4_K_M", digest: <from ollama list>}`, then
    `npm run sib -- flags on finetunedBookmaker` (the flag stays off if training fails by Fri
    12:00).
12. **Evaluate (T-014):** `npm run sib -- backtest` with `e4b` and `e4b-ft`, and write
    `docs/results/finetune.md` with the model digests, prompt versions and seeds.

## Reproducibility (NFR-012)

- One seed (`training.seed`, 42) feeds Python, NumPy, PyTorch (CPU and CUDA), the data order and
  the trainer. The run also calls `set_seed(..., deterministic=True)` where the installed
  transformers has that flag, `torch.use_deterministic_algorithms(True, warn_only=True)` and sets
  `CUBLAS_WORKSPACE_CONFIG=:4096:8` before the GPU is touched.
- What still varies on a GPU: `warn_only` means an operation without a deterministic kernel (some
  bitsandbytes 4-bit and attention kernels, atomics in backward passes) runs anyway and only warns;
  results also differ across GPU models, drivers and CUDA / library versions; `PYTHONHASHSEED` is
  fixed only for child processes unless you export it before starting Python. Expect nearly equal,
  not byte-identical, adapters. The data, the order, the versions, the base-model commit and the
  settings are identical and recorded.
- `run-record.json` holds what a re-run needs: config, dataset manifest hash, file hashes, seeds,
  package versions. The dataset itself is byte-identical for the same snapshot, rules, prompt and
  habits (`sib dataset`).
- Training uses only `train.jsonl`. `training.dataset` refuses a folder whose files differ from the
  manifest hashes, whose training file holds a hold-out row or a date after 31 Aug (the boundary is
  pinned in Python, not taken from the manifest), whose training prompts show a forecast hour of
  1 Sep or later, whose habits (in the manifest and in every row's user message) are not the
  synthetic profile in `habits.synthetic.json`, or whose rows break the format.
- Weights, adapters, checkpoints and GGUF files stay outside the repository (`.gitignore` covers
  `*.gguf`, `*.safetensors`, `checkpoints/`, `adapters/`); the config refuses an output folder
  inside it. The adapter is published on Hugging Face by the builder (Q-11), not committed.

## Development

```bash
cd training
uv sync                  # dev tools only (what CI installs)
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

`tests/fixtures/dataset/` is a tiny real output of `sib dataset` on the synthetic weather of
`test/backtest/support/synthetic-weather.ts` (snapshot 2026-08-27 to 2026-09-02, prompt
`bookmaker.v1`, 20 training and 7 hold-out rows). It carries no real weather and no household data.
To rebuild it after the row format changes, run `buildFinetuneDataset` on that snapshot (see
`test/backtest/finetune/support.ts` for the options) and copy the three files.
