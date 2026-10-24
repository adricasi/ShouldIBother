# 0011. Optional hosted mode on DigitalOcean with Serverless Inference Gemma

- Status: Proposed (2026-10-24)
- Date: 2026-10-24
- Deciders: adricasi
- Amends: ADR-0002 (everything on one laptop) and ADR-0007 (pairing over plain HTTP), for hosted mode only

## Context
Home mode (ADR-0002) needs a laptop with an NVIDIA GPU and the phone on the same Wi-Fi. The builder wants an optional way to use the app away from home: one household, no accounts, deployed by hand, cheap. Home mode stays the default and keeps "Your photos never leave it". See REQ-032, NFR-006, NFR-013.

## Options considered
1. **A Droplet with Docker Compose (Caddy + app) and Gemma from DigitalOcean Serverless Inference.** Pros: no GPU; the persistent disk suits SQLite and photos; about 7–13 US$ a month (estimate below). Cons: a different, larger Gemma than home mode; household text leaves the home.
2. **A GPU Droplet running Ollama.** Pros: the same model as home mode, including the fine-tune. Cons: GPU pricing far above option 1 (not quoted: unverified); idle cost.
3. **App Platform.** Cons: the local filesystem is lost on every deploy or container replacement, which breaks SQLite and photos.
4. **Cloud Run + Vertex AI.** Cons: no persistent local disk for SQLite; a second cloud for one household.

## Decision
We will use option 1, opt-in with `SIB_MODE=hosted`. Home mode is unchanged.

- **Model:** a new `DigitalOceanClient` behind `ModelClient` calls the OpenAI-compatible `POST https://inference.do-ai.run/v1/chat/completions` with a dedicated, inference-only model access key (`Authorization: Bearer`) from a root-owned 0600 env file. Same JobRunner, schemas, deadlines and decision logging. Tool use is `injected` by default, until `sib hosted-check` shows that tool calls work. Photos go to the model only with `SIB_DO_VISION=1`; the default is off, so photos stay on the server.
- **Access:** there are no accounts. The pairing token is hardened for a public host: no token at start; `sib pair` prints `/pair#t=…` to the terminal only; the `/pair` page POSTs the token. The session cookie is `__Host-`prefixed, `Secure`, `SameSite=Strict`, lasting 7 days. Host and Origin are exactly `SIB_PUBLIC_ORIGIN`. Caddy terminates TLS (Let's Encrypt, HSTS, access logs off).
- **Spend:** a daily call cap (`SIB_DAILY_MODEL_CALLS`, default 300, stored in SQLite) with a reserve for judge verdicts. A monthly budget on the model access key pauses the key at 100 %, and account spend alerts are on.
- **Infrastructure:** Terraform in `infra/digitalocean/` (local, git-ignored state; token from `DIGITALOCEAN_TOKEN`) creates:
  - a 1 GiB Basic Droplet in AMS3 (the closest region with daily backups), with daily backups;
  - a reserved IP;
  - a Cloud Firewall (22 from the builder's IP; 80 and 443 public);
  - monitoring alerts and a project.

  Data lives on the Droplet disk so the Droplet backups cover it, plus a nightly online copy kept 7 days. The image is built on the laptop and copied with `docker save | ssh … docker load`. The builder applies and deploys; agents never do.

## Facts and their status (checked 2026-10-24)
Search-engine extracts of DigitalOcean's pages are marked [S]; the builder re-checks them before deploying. "Unverified" means not confirmed.

| Fact | Value | Status |
|---|---|---|
| Inference base URL and auth | `https://inference.do-ai.run`, `Authorization: Bearer <model access key>` | [S] |
| Gemma model ID | `gemma-4-31B-it` (DigitalOcean's model list names "Gemma 4-31B-it"); E4B does not appear to be offered | unverified: confirm with `GET /v1/models` / `sib hosted-check` |
| Vision and tool calling for that model | Gemma 4 supports both; DigitalOcean's support is not documented | unverified: `sib hosted-check` |
| Price | 0.18 US$ / 1M input tokens, 0.50 US$ / 1M output, 0.036 US$ / 1M cache reads | [S] |
| Billing | prepaid balance required (since 29 Jun 2026); per-key monthly budgets with alerts and pause at 100 % (preview); account spend alerts | [S] |
| Data | not used for training, not shared with the model creator; inputs and outputs not stored | [S] |
| Processing region | not documented; likely US | unverified |
| Droplet | Basic 1 GiB / 1 vCPU / 25 GiB: 6 US$/month | [S] |
| Backups | weekly 20 % / daily 30 % of the Droplet price; daily in NYC1, NYC3, SFO3, AMS3, SGP1 | [S] |
| Reserved IP | free while assigned (5 US$/month unassigned) | [S] |
| Monitoring and alerts | free with the metrics agent | [S] |
| Cloud Firewall | free | unverified (marketing page) |
| Encryption at rest of Droplet disks and backups | — | unverified: check before storing household data |
| Images | `caddy:2.11.7`, `node:24.22.1-trixie-slim`; pin both by digest | Docker Hub, read directly |
| Terraform provider | `digitalocean/digitalocean` 2.106.0 | GitHub releases, read directly |

**Cost estimate per month** (4.33 weeks a month; about 6 calls per bet of 2–5k input and 300 output tokens; no domain, tax or image tokens):

| Scale | Model | Hosting | Total |
|---|---|---|---|
| Low: 25 bets/week, 4 calls, 2k input | ~0.22 US$ | 7.20 US$ (weekly backups) | ~7.40 US$ |
| Typical: 100 bets/week, 6 calls, 3.5k input | ~2.03 US$ | 7.80 US$ (daily backups) | ~9.80 US$ |
| High: 100 bets/week, 10 calls, 5k input | ~4.55 US$ | 7.80 US$ | ~12.40 US$ |

## Privacy trade-off
In hosted mode the following are sent to DigitalOcean's inference service:
- chore text, habits, answers to Gemma's questions, inspector observations;
- the area forecast, built from coordinates rounded to 2 decimals;
- photos, but only with `SIB_DO_VISION=1`.

DigitalOcean states it does not store this data or train on it; the processing region is unverified. Household data, the database and photos, lives on a cloud server and in its backups. The app says this on screen in hosted mode (AC-032.6), and the README and the deploy guide repeat it. Home mode is unaffected.

## Consequences
- Positive:
  - no GPU, and HTTPS from anywhere;
  - about 10 US$ a month at the expected volume (estimate);
  - the same code, tests and Gemma jobs as home mode.
- Negative / risks:
  - the hosted Gemma is likely 31B, not E4B, and never the fine-tune, so hosted decisions are kept apart in calibration and comparisons (filter by `model`), and NFR-004 latency is re-measured;
  - when the prepaid balance or the key budget runs out, Gemma is offline: rule odds, settlements wait (AC-008.8);
  - Open-Meteo's free tier is for non-commercial use, which this single-household server is.
- Follow-ups:
  - the builder runs `sib hosted-check` after deploy and records the model ID, vision and tool-call results here;
  - the builder re-checks the [S] facts and encryption at rest before deploying.
