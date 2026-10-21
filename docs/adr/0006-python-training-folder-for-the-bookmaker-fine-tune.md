# 0006. Fine-tune the bookmaker in a Python `training/` folder

- Status: Accepted (2026-10-21)
- Date: 2026-10-21
- Deciders: adricasi

## Context
REQ-019 fine-tunes the E4B bookmaker on public Barcelona weather outcomes (QLoRA, text only) and compares it with the base model on a Sep–Oct 2026 hold-out. The app is TypeScript; the mature QLoRA tooling (Unsloth, TRL + PEFT) is Python. Training runs on the laptop GPU under WSL2, with Colab as a fallback.

## Options considered
1. **Python `training/` folder managed with uv, inside this repo.** Pros: standard tooling, same repo as the dataset builder and evaluation; adapter and GGUF reproducible from one place. Cons: two languages in CI.
2. **Separate training repository.** Pros: clean separation. Cons: the dataset, eval and app drift apart; extra repo to make public within the challenge window.
3. **No fine-tune.** Pros: saves time. Cons: loses a Best Use of Gemma result the builder wants.

## Decision
We will keep a self-contained Python project in `training/` (uv, pinned lockfile, Unsloth or TRL + PEFT) that reads the JSONL dataset produced by the TypeScript backtest pipeline (public weather data and a fixed synthetic habit profile only, never household data), trains a QLoRA adapter on E4B, merges it, converts it to GGUF and imports it into Ollama. The adapter is published on Hugging Face by the builder (Q-11); weights and checkpoints are never committed.

## Consequences
- Positive: one place to reproduce the result; the app treats the fine-tuned model as just another configured model.
- Negative / risks: VRAM limits on 8 GB (T-001 smoke run; Colab fallback); Python standards (`~/ai-toolkit/standards/python.md`) apply to `training/`; CI gains a Python lint job without GPU.
- Follow-ups: the fine-tune is the first thing to put behind a flag if Friday slips.
