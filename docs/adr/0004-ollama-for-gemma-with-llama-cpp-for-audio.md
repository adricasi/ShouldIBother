# 0004. Serve Gemma 4 with Ollama, and llama.cpp for audio

- Status: Proposed (confirmed or revised by the T-001 spike)
- Date: 2026-10-21
- Deciders: adricasi

## Context
Gemma 4 E4B must do text, image, function calling and schema-constrained JSON on an NVIDIA GPU under WSL2; E2B is needed for comparison; a fine-tuned E4B arrives as a merged GGUF; voice (tier 6) needs Gemma 4 audio. Research notes report Gemma audio through Ollama on NVIDIA as unreliable and llama.cpp's Gemma 4 audio as experimental. See [research-notes.md](../discovery/research-notes.md) and Q-2.

## Options considered
1. **Ollama for text, image, tools and JSON; llama.cpp server only for audio.** Pros: simple model management (pull by tag, import GGUF via Modelfile), tool calling and JSON-schema output through its API. Cons: two runtimes if voice is built.
2. **llama.cpp only.** Pros: one runtime including audio; loads GGUF directly. Cons: more manual flags and model files; grammar-based JSON.
3. **Ollama only.** Pros: simplest. Cons: no reliable Gemma audio; voice would need whisper.cpp.

## Decision
We will use Ollama as the primary runtime and llama.cpp's server only for Gemma 4 audio (tier 6), both bound to 127.0.0.1, behind one `ModelClient` interface (Ollama, llama.cpp and a fixture-backed fake). Model tag, quantization and digest live in config, not code.

## Consequences
- Positive: the app code doesn't depend on a runtime; agents build against the fake (NFR-010).
- Negative / risks: Ollama's structured-output and tool-calling support for Gemma 4 must be proven in T-001; if JSON-schema output fails, fall back to llama.cpp with a grammar for that job.
- Follow-ups: record the measured latency, VRAM use, quantization and digests in this ADR after the spike; `OLLAMA_HOST` stays at 127.0.0.1.
