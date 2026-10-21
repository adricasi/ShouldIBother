# 0002. Run everything locally on one laptop

- Status: Proposed
- Date: 2026-10-21
- Deciders: adricasi

## Context
Should I Bother? handles photos of the user's home, their habits and (later) voice notes. The challenge targets "Best Use of Gemma" and open innovation; the budget is ~0 €; the builder has one Windows laptop with an NVIDIA GPU (8 GB+ VRAM, WSL2) and a phone. See [product.md](../spec/product.md) G-5 and NFR-002.

## Options considered
1. **Local / on-device: laptop runs model, server, storage; phone uses the web app over home Wi-Fi.** Pros: private by design, zero running cost, offline except weather, fits the open-model story. Cons: setup friction (GPU, model download, LAN networking from WSL2), no HTTPS by default.
2. **GCP (Cloud Run + Vertex AI Gemma or a GPU VM).** Pros: HTTPS and reachability anywhere. Cons: home photos leave the device, GPU cost, IAM/infra work that does nothing for the product in a 4-day build.
3. **Phone-only (on-device model in the browser or a native app).** Pros: purest privacy. Cons: E4B with image input in a mobile browser is not realistic in this timeframe; native apps are a non-goal.

## Decision
We will run everything on the builder's laptop (option 1), because it keeps household data on the device, costs nothing, and makes the local open model the protagonist. The only runtime call that leaves the laptop is Open-Meteo, with coordinates rounded to 2 decimals.

## Consequences
- Positive: no cloud accounts, IAM or Terraform; privacy claim is simple and checkable.
- Negative / risks: phone access over plain HTTP (mitigated by pairing tokens, ADR-0007, and Tailscale Serve as an HTTPS option); WSL2 networking needs mirrored mode or a portproxy plus a Windows firewall rule (T-001 spike).
- Follow-ups: README setup for WSL2, Ollama and the model download; network check that only Open-Meteo is contacted.
