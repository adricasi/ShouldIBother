# Design: Should I Bother?

- Status: Approved (2026-10-21) <!-- Draft | In review | Approved -->
- Last updated: 2026-10-22
- Implements: requirements.md (REQ-*, NFR-*)

## Overview
- Deployment target: **Local / on-device** ([ADR-0002](../adr/0002-run-everything-locally-on-one-laptop.md)).

One Windows laptop (WSL2, NVIDIA GPU) runs a single Node.js process: a Fastify server that serves a React SPA and a JSON API, keeps everything in SQLite, runs a scheduler loop, and talks to Gemma 4 through Ollama on 127.0.0.1. The phone opens the SPA over home Wi-Fi after pairing with a one-time token. Gemma makes every judgement (listener, inspector, bookmaker, safety guard, judge, laundry planner); deterministic code computes the rule baseline, the safety backstop, points and savings, and stores everything. The only call that leaves the laptop is Open-Meteo. A separate offline pipeline (TypeScript backtest + Python fine-tune) produces the evaluation numbers and the fine-tuned bookmaker.

```mermaid
flowchart LR
  subgraph Phone["Phone browser (home Wi-Fi)"]
    SPA["React SPA\nToday · Bet sheet · Slips · Settle · Receipt · Score"]
  end
  subgraph Laptop["Laptop · WSL2"]
    subgraph Server["Node.js 24 process (Fastify)"]
      AUTH["Pairing + session guard"]
      API["API routes"]
      JOBS["Gemma jobs\nprompts + zod schemas"]
      RULE["Rule baseline\n+ safety backstop"]
      LEDGER["Bets · settlement\npoints · savings"]
      WX["Weather service\n+ cache"]
      SCHED["Scheduler loop (60 s)"]
      PHOTO["Photo store\n(strip EXIF, resize)"]
    end
    DB[("SQLite + photos\n~/.should-i-bother/")]
    OLLAMA["Ollama 127.0.0.1:11434\nGemma 4 E4B / E2B / fine-tuned"]
    LCPP["llama.cpp server 127.0.0.1\n(audio, tier 6)"]
    OFFLINE["Offline: backtest (TS)\n+ training/ (Python QLoRA)"]
  end
  OM["Open-Meteo\nforecast · previous runs · historical forecast · archive"]
  SPA -- "HTTP + session cookie" --> AUTH --> API
  API --> JOBS --> OLLAMA
  JOBS -. "audio" .-> LCPP
  JOBS -- "get_forecast tool" --> WX
  API --> RULE
  API --> LEDGER --> DB
  PHOTO --> DB
  SCHED --> LEDGER
  WX -- "only outbound call" --> OM
  OFFLINE --> OM
  OFFLINE -- "GGUF import" --> OLLAMA
```

## Options considered
| Decision | Options | Chosen | ADR |
|---|---|---|---|
| Deployment target | Local laptop · GCP · phone-only | Local laptop: private, 0 €, open-model story | [0002](../adr/0002-run-everything-locally-on-one-laptop.md) |
| App architecture | One Node process + React SPA · same + htmx · Next.js | One Fastify process + Vite React SPA + SQLite + in-process scheduler | [0003](../adr/0003-one-node-process-with-a-react-spa.md) |
| Model runtime | Ollama + llama.cpp (audio) · llama.cpp only · Ollama only | Ollama primary, llama.cpp only for audio; spike confirms | [0004](../adr/0004-ollama-for-gemma-with-llama-cpp-for-audio.md) |
| Odds model | Gemma % · rule + bounded Gemma · Gemma bands + rule baseline | Gemma bands mapped to fixed odds; rule scored alongside | [0005](../adr/0005-gemma-sets-odds-as-bands-with-a-rule-baseline.md) |
| Fine-tune tooling | Python `training/` in repo · separate repo · none | Python `training/` (uv, Unsloth or TRL + PEFT) | [0006](../adr/0006-python-training-folder-for-the-bookmaker-fine-tune.md) |
| LAN access | No auth · pairing token on HTTP · HTTPS only | Hardened pairing token; Tailscale Serve documented | [0007](../adr/0007-pairing-token-access-over-plain-http-on-the-lan.md) |
| Weather sources | Forecast past hours · wait for archive · own station | Forecast API (odds), its past hours (live settlement), Previous Runs day-1 lead + archive (backtest) | [0008](../adr/0008-weather-sources-for-odds-settlement-and-backtest.md) |
| Cards without odds | New card kind per case · reject the request · `coming_later` + `notice` | `coming_later` card with a `notice` (no table rebuild) | [0009](../adr/0009-cards-without-odds-are-coming-later-cards-with-a-notice.md) |

## Components
| Component | Responsibility | Tech / local runtime | Requirements |
|---|---|---|---|
| Web client | Screens from the Figma design; data layer with zod-validated responses; polls `/api/today` and `/api/slips` every 30 s while visible; provisional → Gemma odds swap | React + Vite, CSS custom properties from `docs/design/tokens.css`, Lucide icons | REQ-002–011, 013, 017, 020, 026, 028; NFR-009 |
| HTTP server | Static SPA, JSON API, photo files, security headers (CSP, nosniff, Referrer-Policy), Host allowlist, body limits | Fastify on Node.js 24 LTS | All; NFR-001 |
| Pairing + session guard | Token generation, QR print, token → cookie exchange, session check on every route, Origin check, rate limit, forget devices | Node `crypto` (randomBytes, timingSafeEqual, SHA-256) | REQ-001; NFR-001 |
| Gemma jobs | One module per job: prompt file + input builder + zod output schema + JSON schema sent to the runtime; validate, retry once with the validation error, then fail clearly; at most 4 model calls per job (first attempt: tool call + answer; one retry: the same); jobs run one at a time through a single FIFO queue that holds at most 8 jobs (a ninth is refused as "busy", AC-013.6); 30 s per model call and a 45 s deadline per job measured from enqueue, so GPU queue time counts (a photo's inspector + bookmaker share one deadline) | `prompts/<job>.v<n>.md`; `ModelClient` interface ([ADR-0004](../adr/0004-ollama-for-gemma-with-llama-cpp-for-audio.md)) | REQ-002, 003, 005, 008, 012, 021, 027, 028 |
| ModelClient | `chat({messages, images, tools, schema, timeoutMs})`; implementations: Ollama, llama.cpp (audio), Fake (fixtures by job + scenario name, so prompt changes don't invalidate them). The Fake is chosen only by `SIB_FAKE_MODEL=1` (tests, CI, `npm run dev`; the console says so loudly); `sib start` refuses to start when `config/models.json` has no Gemma tag, and with Ollama down it starts anyway and Gemma shows offline (rule odds, Retry, settlements wait) | Ollama HTTP API on 127.0.0.1; fixtures in `test/fixtures/gemma/` | NFR-004, NFR-010 |
| Rule baseline | Pure functions: chore + forecast window → band; drying index; thresholds from config | TypeScript, config `config/rules.json` | REQ-004, 013, 018 |
| Safety backstop | Pure function: forecast window → alert or not (heat, frost, storm) | TypeScript, config `config/rules.json` | REQ-012 |
| Weather service | Open-Meteo client; forecast cache (1 h) in SQLite; past-hours fetch for settlement; serves the `get_forecast` tool from cache; location fixed by config, never chosen by the model; host allowlist (`api`, `previous-runs-api`, `historical-forecast-api`, `archive-api` `.open-meteo.com`) enforced in the client with a CI test (AC-014.7) | `fetch` with timeout + retry (backoff, jitter) | REQ-014; NFR-002, 006 |
| Photo store | Accept ≤ 10 MB images that are JPEG, PNG, WebP or HEIF by their first bytes (HEIC/AVIF only if the installed sharp/libvips build decodes it, checked with a real iPhone photo in T-001); every other libvips loader is blocked; decode, auto-rotate, re-encode to JPEG ≤ 1024 px with all metadata dropped; random UUID filenames; one upload is processed at a time (a second gets 409); a photo is written as `<uuid>.tmp`, its row is inserted, then the file is renamed to `<uuid>.jpg`, and an orphan sweep at start removes temporary files and photo files no row names. Unsupported or undecodable formats → 415 problem+json with a clear message ("This photo format isn't supported; set the camera to Most Compatible or send a JPEG"), never a 500 | sharp | REQ-005, 008, 015; NFR-002 |
| Ledger | Cards, quotes, bets, decisions, settlement state machine, points (pure), savings (pure, from a snapshot taken at bet time) | TypeScript + better-sqlite3 (transactions) | REQ-006–011, 016, 021–025 |
| Scheduler | Every 60 s: mark due bets, fetch recorded weather (retry 30 min), auto-settle after 24 h, retry `awaiting_gemma` (a failed bet waits 2 min before the next try), rescue checks (flagged); all state in SQLite, so restart-safe | `setInterval` in the server process | REQ-007, 008, 014, 022; NFR-003 |
| Feature flags | `config/flags.json`; off by default; disabled features have no UI entry and no route | Fastify plugin registration per flag | REQ-029 |
| CLI | `sib pair` · `sib forget-devices` · `sib delete-photos [--all-data]` · `sib export <dir>` · `sib snapshot` · `sib dataset` · `sib backtest` · `sib eval <job>` | Node bin entry (`src/cli.ts`) | REQ-001, 015, 018, 019 |
| Backtest + eval | Replays Apr–Oct 2026: decisions at each chore's fixed decision time from Previous Runs day-1-lead forecasts (fallback Historical Forecast, labelled "short-lead"), outcomes from the outcome labels on the archive; runs rule, fixed routine, E2B, E4B base; the fine-tuned column comes from the hold-out evaluation (T-014); headline numbers on Sep–Oct; resumable, paused from 07:00; writes report + calibration + the fine-tune JSONL | TypeScript; weather snapshot in `data-snapshots/` (CC BY 4.0) | REQ-018, 019; NFR-005, 012 |
| Training | QLoRA on E4B (text-only), merge, GGUF convert, Ollama Modelfile import; seeds and versions pinned | Python in `training/` (uv; Unsloth or TRL + PEFT) | REQ-019; NFR-012 |
| Model runtimes | Gemma 4 E4B (primary), E2B (backtest comparison), fine-tuned E4B; audio via llama.cpp | Ollama, llama.cpp server; both on 127.0.0.1 | REQ-003, 018, 019, 027 |

### Gemma jobs
All prompts tell the model that user text, photos and tool results are untrusted data inside delimiters. Outputs are enums plus short strings; code never acts on free text.

| Job | Input | Output schema (essentials) | Notes |
|---|---|---|---|
| Listener | Typed text (≤ 500 chars) or transcript | `chores[]: {label, chore_type: enum(plants, laundry_line, laundry_tonight, laundry_plan, ac, heater, other_weather, not_weather), item?}` | Unknown types → "Coming later" / "Not a weather chore"; AC and heater → "Not needed this season" when the baseline says so (AC-016.5); the card kinds for these are in [ADR-0009](../adr/0009-cards-without-odds-are-coming-later-cards-with-a-notice.md) |
| Inspector | Photo + chore type | `status: ok|unsure; observations[]: {name, value}` (soil dryness, wilting, cover, dampness); `question?` | Shown as "What Gemma saw" |
| Bookmaker | Chore, habits, inspector observations, rule band; tool `get_forecast(hours_ahead ≤ 48)` | `status: ok|unsure; band: enum(5); reason ≤ 140 chars; settle_in_hours; disagreement_reason?; question?` | Tool use enforced in code: an answer without a `get_forecast` call is retried once, then the card keeps labelled rule odds (AC-003.6); the miss is logged and counted (tool-call miss rate in the evaluation). Settle time clamped to chore bounds; ≥ 2 bands from rule requires `disagreement_reason` or `question`; a card asks at most 2 questions and stores at most 3 answers, then the rule odds stay. Fallback if T-001 shows tool calling or schema output fails on the runtime: the app fetches the forecast itself and passes it as the tool result (`tool_mode = injected`, recorded per decision and reported separately from the tool-call miss rate); Gemma still decides |
| Safety guard | Chore, text, forecast | `alert: bool; reason?` | Fixed backstop applies regardless |
| Judge | Before/after photos or tap answer, recorded weather, bet | `status: ok|unsure; verdict: enum(win, small_loss, normal_loss, harmful_loss) or for do-it: enum(weather_would_have, weather_would_not); reason; evidence[]; question?` | Never replaced by the rule; asks at most 2 questions per bet; `lucky_win` is computed by code from the outcome label (AC-008.6), not by the judge |
| Laundry planner | 4-day drying forecast, "need it by" | `state: enum(wash_today, skip_today, no_good_day); best_day; days[]: {date, score}` | Flagged (tier 5) |

### Rule baseline and safety backstop (final values for this version — Q-5 closed)
Bands are ordinal 0 (very unlikely) … 4 (very likely). The values below [ASSUMPTION A-12] live in `config/rules.json` and are **final for this version: no tuning**, so the rule stays an untuned baseline and the band in every training row equals the live one; the backtest reports them as-is. Within each chore the rows are evaluated top to bottom and the **first match wins**; intervals are half-open (lower bound included). A "wet hour" has precipitation ≥ 0.2 mm.

| Chore | Window | Rule (first match wins) |
|---|---|---|
| Water balcony plants | now → settle (next morning) | rain ≥ 5 mm → 4 · rain ≥ 2 mm → 3 · rain ≥ 0.5 mm or max hourly probability ≥ 60% → 2 · max temp < 26 °C → 1 · else → 0 (rain = total precipitation over the window) |
| Line-dry today (skip the dryer) | now → 18:00 | any wet hour → 0 · mean drying index D over the window's daylight hours: D ≥ 0.60 → 4 · D ≥ 0.45 → 3 · D ≥ 0.30 → 2 · D ≥ 0.15 → 1 · else → 0 |
| Leave laundry out tonight | sunset → 08:00 | any wet hour → 0 · ≥ 3 hours with temp − dew point ≤ 2 °C (dew) → 1 · mean D over the window: D ≥ 0.45 → 3 · D ≥ 0.30 → 2 · else → 1 |
| Skip the AC | 22:00–07:00 | night min < 21 °C → 4 · < 23 → 3 · < 25 → 2 · < 27 → 1 · else → 0; then mean wind ≥ 10 km/h lifts one band (max 4) |
| Skip the heater | 08:00–22:00 | day max ≥ 20 °C and sunshine ≥ 5 h → 4 · day max ≥ 18 °C → 3 · ≥ 15 °C → 2 · ≥ 12 °C → 1 · else → 0 |
| Drying index D | per hour | 0.5 · min(wind km/h, 30)/30 + 0.3 · (100 − RH)/100 + 0.2 · sunshine seconds/3600; a wet hour scores 0 |
| Safety backstop | card window | heat: max ≥ 35 °C · frost: min ≤ 2 °C · storm: gusts ≥ 70 km/h or WMO codes 95–99 → "Do it now" alert |

### Outcome labels ("weather delivered")
One pure function per chore in `src/domain/outcomes.ts`, used by the backtest, the fine-tune targets and `lucky_win` (AC-008.6). They answer "would the weather have done the chore?" from recorded weather (a window's hours are every hour that overlaps it, so the hour containing a mid-hour sunset is included); they are separate from the rule's band thresholds, and they do not observe plant health or the actual load (live outcomes come from the photo or tap; the post says so). Each chore has a fixed decision time for the backtest, so the lookahead test (AC-018.1) can check every forecast's model-run start against it.

| Chore | Backtest decision time | Window | Label is true when |
|---|---|---|---|
| Water balcony plants | 19:00 | 19:00 → 10:00 next day | ET0 − rain over the window ≤ 1.0 mm (pots stay moist enough for one skipped watering), using Open-Meteo `et0_fao_evapotranspiration` (T-001 confirms it is in the archive); if ET0 is unavailable, rain ≥ 2 mm, labelled in the report |
| Line-dry today | 09:00 | 10:00 → 18:00 | no wet hour and Σ D over the window ≥ 3.0 |
| Leave laundry out tonight | 20:00 | sunset → 08:00 | no wet hour and fewer than 3 hours with temp − dew point ≤ 2 °C |
| Skip the AC | 21:00 | 22:00 → 07:00 | night min < 23 °C |
| Skip the heater | 08:00 | 08:00 → 22:00 | day max ≥ 18 °C, or day max ≥ 15 °C and sunshine ≥ 5 h |

### Settle-time bounds
Gemma proposes `settle_in_hours`; code clamps it (Europe/Madrid): plants next day 08:00–12:00 · line-dry today same day 18:00–21:00 · laundry tonight next day 08:00–10:00 · AC next day 07:00–09:00 · heater same day 21:00–23:00 · laundry Skip today: the chosen day 18:00. Bounds and rule windows are anchored on the card's `created_at`, not on the moment Gemma answers, so a late answer or a Retry cannot move them. The safety backstop is checked again on the final settle window Gemma chose (AC-012.1).

### Points and savings (pure functions)
- Points as in [requirements.md](requirements.md) (fixed values); total = sum of settled bets' points.
- Savings snapshot on the bet at placement: catalogue figure for the chore × household baseline (`config/household.json`, A-6), with the assumption text. Net time = Σ time saved on wins − 30 s × bets placed (not undone). The snapshot is written in the bet's INSERT; a bet that has none (placed before savings existed) gets one backfilled at start, once, from today's catalogue and baseline. A figure without a cited source is labelled "typical estimate" (condenser dryer, plants, laundry tonight). Weekly totals attribute a bet, whole, to the Madrid week of its `settle_at`.

## Data model
SQLite, one file in the data folder (default `~/.should-i-bother/`, `SIB_DATA_DIR` to override; `data/` also git-ignored). All data is **household-private** (NFR-002); kept until the user deletes it (REQ-015).

| Entity | Key fields | Notes |
|---|---|---|
| `pairing` | token_hash, created_at, expires_at (10 min), revoked_at, sessions_created (max 3) | New token per start or `sib pair`; hash only |
| `sessions` | id_hash, created_at, expires_at (30 days), last_seen_at, revoked_at | Cookie holds the raw id; DB holds SHA-256 |
| `cards` | id, input_text, chore_type, kind (weather · not_weather · coming_later · alert), alert_reason, notice (0004), gemma_state (thinking · answered · question · offline), gemma_failure, gemma_question, gemma_answers (JSON list of questions and taps) (0005), photo_state (inspecting · seen · unsure · failed), photo_failure (0006), created_at | `notice` holds the words of a card with no odds and no bet action, which is stored as `coming_later` ([ADR-0009](../adr/0009-cards-without-odds-are-coming-later-cards-with-a-notice.md)). Gemma and photo state survive a restart: on start `thinking` becomes `offline` (failure `restart`) and `inspecting` becomes `failed` |
| `quotes` | id, card_id, source (rule · gemma), band, odds, with_photo, photo_id, reason, settle_at, decision_id, created_at | Latest Gemma quote replaces the rule quote in the UI; a quote made with a photo is deleted with it |
| `photos` | id (UUID), card_id/bet_id, role (before · after · appeal), file, received_at, width, height | Files in `photos/`; served only through the session guard |
| `bets` | id, card_id, kind (do_nothing · do_it), band, odds, odds_source, reason, gemma_band, rule_band, band_without_photo, model_version, prompt_version, savings_snapshot (JSON), placed_at, undo_until, settle_at, status (open · due · awaiting_weather · awaiting_gemma · settled · undone · cashed_out) | `reason` is the reason shown at bet time, copied so a later delete of the quote cannot change the locked slip (AC-006.1). Triggers (0003) refuse any update of id, card_id, kind, band, odds, odds_source, reason, gemma_band, rule_band, placed_at, undo_until and settle_at, and allow `savings_snapshot`, `model_version`, `prompt_version` and `band_without_photo` to go from NULL to a value once; all four are written in the INSERT. The same triggers enforce the status arrows. A partial unique index allows one active (not undone) bet per card |
| `settlements` | bet_id, evidence (photo · tap · auto), multiplier, multiplier_capped (0007), verdict, lucky_win (computed by code), weather (JSON), decision_id, points, settled_at, appeal_of, final | Appeal adds a row with `appeal_of`. `multiplier_capped` = 1 marks a settlement committed at or after settle_at + 24 h whose win multiplier was capped at ×0.5 whatever the evidence; the evidence column keeps the real evidence. A do-it decision is stored with evidence `auto` and multiplier 1 (no multiplier applies to its fixed points), so anything that reads `auto` must filter by the bet's kind |
| `settle_progress` | bet_id, evidence (tap · photo), answer_id, photo_id, before_photo_id, answered_at, question, followups (JSON), weather (JSON), tried_at, failure | (0007) What a bet knows while it settles: the user's answer is stored the moment it is given, before the judge is called, so an offline judge loses nothing (AC-008.8); the judge's open question and earlier taps (AC-008.5); the recorded-weather snapshot shown on the settle screen; when and why the judge was last tried. Stays after settlement so deleting either photo also deletes the judge's decisions (AC-015.2) |
| `gemma_decisions` | id, job, card_id, bet_id, photo_id, model, model_digest, prompt_version, tool_mode (called · injected · missed), input_summary, output (JSON), valid, retries, latency_ms, error, created_at | Feeds evaluation (REQ-028); card/bet/photo ids let deletes cascade (AC-015.2) |
| `weather_cache` | key (endpoint, rounded lat/lon, range), fetched_at, body (JSON) | Forecast TTL 1 h |
| `achievements` | id, unlocked_at | Flagged (tier 5) |

Migrations as merged (`src/server/migrations/`): 0001 pairing_sessions · 0002 core_schema · 0003 bet_locks · 0004 card_notices · 0005 gemma_cards · 0006 card_photos · 0007 settle_progress. Each adds to the schema without rewriting existing rows.

Bet state machine: `open → due → (awaiting_weather) → (awaiting_gemma) → settled`; `open → undone` (up to and including 5 min after placing; the bet keeps its row with status `undone` so net time can leave it out); `open|due → cashed_out` (flagged). Auto-settle moves `due` to judging at settle_at + 24 h with ×0.5.

## Interfaces
JSON over HTTP, same origin, one client; no API versioning (client and server ship together). Errors use RFC 9457 `application/problem+json`. All routes require a session except `/pair`.

| Method · Path | Purpose | Requirements |
|---|---|---|
| GET `/pair?token=` | Exchange token → cookie, 303 to `/` | REQ-001 |
| GET `/healthz` | Liveness; needs a session like every route except `/pair` | REQ-001 |
| POST `/api/devices/forget` | Revoke all sessions and the token | REQ-001 |
| GET `/api/today` | Week savings, weather summary + age, Gemma status, open cards | REQ-011, 013, 014 |
| POST `/api/cards` `{text}` · POST `/api/cards/quick` `{chore_type}` | Capture → cards (rule quote at once; Gemma jobs async) | REQ-002, 004, 012, 013 |
| GET `/api/cards/:id` | Card with latest quote (polled until Gemma answers or times out) | REQ-003, 013 |
| POST `/api/cards/:id/photo` (multipart) | Add before photo → inspector → bookmaker (replaces an earlier one; 409 while another upload is processed; 503 when Gemma's queue is full) | REQ-005 |
| POST `/api/cards/:id/answer` `{yes}` · POST `/api/cards/:id/retry` | Answer Gemma's question · retry Gemma (503 when the queue is full, before any change) | REQ-003, 013 |
| POST `/api/bets` `{card_id, quote_id, kind}` · DELETE `/api/bets/:id` | Place: locks the quote the user saw (201; 409 if that is no longer the card's latest quote, if its settle time has passed, if the card is an alert or has no odds, or if the card already has an active bet) · undo (up to and including 5 min after placing, else 409) | REQ-006, 012 |
| GET `/api/slips` | Settle now (settle_at ≤ now, computed at read time) · waiting · settled | REQ-007 |
| POST `/api/bets/:id/settle` (tap JSON `{answer}` or multipart photo) · POST `/api/bets/:id/answer` `{yes}` · GET `/api/bets/:id/receipt` | Store the answer, then judge → verdict, points, receipt (200), a question (200), or the saved answer waiting for weather or Gemma (202); answer to the judge's question; the receipt of a settled bet. Refusals (409 too late, 503 busy) come before the answer is written | REQ-008–010 |
| POST `/api/bets/:id/appeal` · `/cashout` | Flagged (tier 5) | REQ-022, 023 |
| GET `/api/score` | Points, rank, savings, calibration (Gemma vs rule, N per band), overrule rate | REQ-020, 025 |
| GET `/photos/:id` · DELETE `/api/photos/:id` · DELETE `/api/bets/:id/data` | Serve / delete household data | REQ-015 |

Model tool exposed to Gemma: `get_forecast({hours_ahead: 1..48})` → hourly precipitation (mm, probability), temperature, dew point, relative humidity, wind speed and gusts, sunshine duration, weather code. No other tools.

## Security design
- Identities: one household; devices identified by session cookies after pairing. No user accounts. The laptop's OS user owns the data folder.
- Access control: session guard on every route including photos and `/healthz` (REQ-001); Origin check on state-changing requests against the app's own origins (allowlisted hosts over http plus `config.publicOrigins`, e.g. `https://<machine>.<tailnet>.ts.net` for Tailscale Serve); Host header (with port) must be in an allowlist built at start-up from `localhost`, `127.0.0.1`, the addresses of the active network interfaces (the LAN IP can change, and WSL mirrored networking exposes the Windows addresses), `config.allowedHosts` (e.g. the Windows LAN IP when using a netsh portproxy) and the hosts of `config.publicOrigins` (all three come from `config/server.json`, git-ignored because it names the machine, with `config/server.example.json` as the committed fallback), otherwise 421 (AC-001.9), which blocks DNS rebinding; the allowlist is printed at start and rebuilt on restart; the session cookie also gets `Secure` when pairing through an https public origin (AC-001.10); rate limit: more than 10 unauthenticated failures/min per client address blocks further unauthenticated requests for 1 min, never valid sessions (behind a portproxy or Tailscale Serve all clients share one address, so the limit becomes global; acceptable for one household, tested in T-001); pairing tokens valid 10 min for at most 3 devices, each pairing printed to the console; sessions 30 days; the `/pair` query string is redacted from request logs; CLI commands run only on the laptop.
- Secrets: none in the repo. The pairing token and session ids are generated at runtime and stored only as SHA-256 hashes in SQLite. A Hugging Face token for publishing the adapter (Q-11) lives in the builder's environment, never in the repo or app.
- Network exposure: Fastify listens on 127.0.0.1 and the LAN address only (port from config, default 8787 [ASSUMPTION A-13]); Ollama and llama.cpp on 127.0.0.1 only (`OLLAMA_HOST` unchanged). WSL2 mirrored networking (or a netsh portproxy) plus one Windows firewall inbound rule for the app port, Private profile only. HTTPS option: Tailscale Serve (tailnet-private).
- Calls that leave the device: Open-Meteo only (forecast, Previous Runs, Historical Forecast, archive), enforced by the weather client's host allowlist (AC-014.7), coordinates rounded to 2 decimals; model downloads at setup (Ollama registry, Hugging Face); adapter upload by the builder by hand. No telemetry.
- Data protection: photos re-encoded without metadata, ≤ 1024 px; data folder outside the source tree and git-ignored; SQLite `secure_delete=ON` with a WAL checkpoint after deletes; gitleaks in pre-commit and CI; committed Gemma fixtures recorded only from staged or synthetic inputs and reviewed by hand (gitleaks does not catch images); export and delete commands (REQ-015). No encryption at rest beyond the OS (single-user laptop) [ASSUMPTION A-14].
- Model output handling: outputs are schema-validated enums and short strings; points, savings, settle bounds and safety are computed by code; text is rendered as text (React escaping, no `dangerouslySetInnerHTML`); CSP `default-src 'self'; img-src 'self' blob: data:` (photo previews before upload) with fonts self-hosted.

| Threat | Mitigation |
|---|---|
| Another device on the Wi-Fi opens the app | Pairing token → session; 401 everywhere else |
| Cookie sniffing on plain HTTP | Documented limit; Tailscale Serve for HTTPS |
| CSRF / DNS rebinding from a web page on the phone or laptop | SameSite=Strict, Origin check, Host allowlist |
| Ollama API reachable from the LAN (model abuse, file reads via API) | Bound to 127.0.0.1; setup check with `ss -ltnp` |
| Malicious or huge upload | 10 MB limit, image decode with sharp, re-encode, random names, `nosniff` |
| Prompt injection via typed text or text in a photo | Data delimited; enum outputs; code decides points, settle bounds and safety; Gemma has one read-only tool |
| Home photos or the database committed to the public repo | Data outside the repo, `.gitignore`, gitleaks, export reviewed by hand before the post |
| Supply chain | Lockfiles (npm, uv), `npm audit`, Dependabot, model pinned by digest |

## Reliability and operations
- Failure modes and handling:
  | Failure | Behaviour |
  |---|---|
  | Gemma not running / job deadline (45 s) passed / invalid JSON after retry / no tool call after retry | Rule odds labelled, Retry offered, betting allowed (REQ-013); settlements wait in `awaiting_gemma` (AC-008.8) |
  | Model still loading | Status "Gemma waking up"; warm-up call at server start |
  | Open-Meteo down | Cached forecast with age; no new bets when none < 24 h old (AC-014.4); settlement retries every 30 min |
  | Server or laptop restart | All state in SQLite; scheduler resumes from DB (NFR-003) |
  | Phone loses Wi-Fi | SPA shows "Can't reach the laptop" and retries polling |
  | Disk full / DB error | Request fails with problem+json; nothing half-written (transactions) |
- GPU and model residency (8 GB VRAM: one GPU user at a time):
  - Live week: Ollama `keep_alive` set long (e.g. 24 h) so a card after an idle pause doesn't wait for a model reload; warm-up call at server start.
  - Training (T-012, Thu night): place the evening's bets, then `ollama stop` every loaded model, then train. Gemma shows offline overnight and settlements wait in `awaiting_gemma` (AC-008.8); that is the designed behaviour.
  - Backtest (T-019, Fri night): runs through Ollama; cards created meanwhile may get rule odds (`odds_source = rule`, excluded from Gemma's calibration); paused from 07:00 so morning settlements get the GPU.
- Observability: pino JSON logs to stdout (no log file is kept in the data folder), redacting tokens, cookies and photo bytes; Gemma call log fields per NFR-007; `gemma_decisions` table for evaluation; Gemma status in the UI.
- Backups / recovery: `sib export` (JSON + photos) before the post and after the live week; copying the data folder is a full backup.

## Environments and deployment
- Environments: **dev/CI** (any machine, fake model (`SIB_FAKE_MODEL=1`), fake weather (`SIB_FAKE_WEATHER=1`, development only), no GPU, no network) and **live** (the builder's laptop). No staging.
- Supported machine: Windows 11 + WSL2 Ubuntu, NVIDIA GPU ≥ 8 GB VRAM with the WSL CUDA driver, ≥ 16 GB RAM (A-11), ~20 GB free disk for models; Node.js 24, pinned (`.nvmrc` = 24, `engines` `>=24 <25`, CI `node-version: 24`) so a move of `lts/*` to Node 26 can't break native modules (better-sqlite3, sharp); Ollama; Python 3.12 + uv (training only). Phone: current iOS Safari or Android Chrome.
- Setup (README, NFR-011): clone → `npm ci` → install Ollama → `npm run setup` (pulls the pinned Gemma tags and verifies digests from `config/models.json`) → `.wslconfig` mirrored networking + firewall rule (manual, Windows admin) → `npm start` → scan the QR.
- Models: Gemma 4 E4B and E2B by Ollama tag + digest (exact tags and quantization recorded after T-001); fine-tuned GGUF imported with a Modelfile; weights git-ignored (`models/`, `*.gguf`).
- Distribution: public GitHub repo (MIT); the human tags releases. Adapter on Hugging Face (Q-11).
- CI: existing GitHub Actions (lint, typecheck, test, audit, gitleaks) without cloud credentials, pinned to Node 24; plus a Python job for `training/` (ruff + pytest, no GPU, no network). Both workflow changes approved by the builder on 2026-10-21.

## Testing strategy
- Unit (Vitest): points, payout rounding, rule bands, drying index, safety backstop, settle-time clamping, savings and net time, bet state machine, auth helpers (token, hashing, Origin/Host checks). Every AC with deterministic logic has a test named after it.
- Integration (Vitest + Fastify `inject`): API routes with in-memory SQLite, `FakeModelClient` (recorded fixtures, including invalid JSON, "unsure", timeout) and a fake weather client; covers REQ-001–016, 028, 029 end to end without a GPU.
- Component (Vitest + Testing Library): cards (provisional → Gemma), bet sheet, settle, receipt, empty states; axe checks.
- E2E (Playwright, phone width): capture → bet → settle with the fake model; axe; run locally and in CI if time allows.
- Live evals (manual, on the laptop): `sib eval <job>` runs 20-case sets per Gemma job against Ollama and records model, digest, quantization, prompt version, valid-JSON rate and latency (NFR-004); backtest and fine-tune reports (REQ-018, 019).
- Fixtures: keyed by job + scenario name. Until T-010, agents use hand-written synthetic fixtures; T-010 re-records them from the real model on staged or synthetic inputs, and they are refreshed whenever a prompt version changes. Migration tests in agent tasks use a seeded fixture database; the builder checks each migration on a copy of the live database at merge time.

## Cost estimate
- Running cost: 0 € (local model, free non-commercial Open-Meteo, ≤ 1,000 calls/day).
- Hardware: the builder's existing laptop; estimate < 2 kWh of electricity for the overnight fine-tune (estimate, measured if possible).
- Paid APIs: none. Colab free tier only as a training fallback.

## Decisions
| ID | Decision | ADR |
|---|---|---|
| D-1 | Run everything locally on one laptop; Open-Meteo is the only outbound call | [0002](../adr/0002-run-everything-locally-on-one-laptop.md) |
| D-2 | One Fastify process serving a React SPA, SQLite via better-sqlite3, in-process scheduler | [0003](../adr/0003-one-node-process-with-a-react-spa.md) |
| D-3 | Ollama for Gemma; llama.cpp only for audio; `ModelClient` with a fixture fake | [0004](../adr/0004-ollama-for-gemma-with-llama-cpp-for-audio.md) |
| D-4 | Gemma returns five bands mapped to 85/70/50/35/15; rule baseline on every bet | [0005](../adr/0005-gemma-sets-odds-as-bands-with-a-rule-baseline.md) |
| D-5 | Python `training/` for the QLoRA fine-tune | [0006](../adr/0006-python-training-folder-for-the-bookmaker-fine-tune.md) |
| D-6 | Hardened pairing token over plain HTTP; Tailscale Serve as the HTTPS option | [0007](../adr/0007-pairing-token-access-over-plain-http-on-the-lan.md) |
| D-7 | Weather: forecast for odds, forecast past hours for live settlement, Previous Runs day-1 lead (fallback Historical Forecast) + archive for the backtest | [0008](../adr/0008-weather-sources-for-odds-settlement-and-backtest.md) |
| D-8 | zod for all schemas; sharp for photos; pino for logs | — (library choices) |
| D-9 | A card with no odds and no bet action is a `coming_later` card with a `notice` | [0009](../adr/0009-cards-without-odds-are-coming-later-cards-with-a-notice.md) |

### Fine-tune dataset (REQ-019)
- Input: the same conversation the live bookmaker sees (prompt version frozen in T-010): system prompt, chore type, habits, rule band (computed by the live `src/domain/rules` code), the `get_forecast` tool call and its result built from the day-1-lead forecast as known at the chore's decision time. No photo (text-only).
- Habits: a fixed synthetic profile written into the manifest, never `config/household.json`; the build fails if any household value appears in a row (AC-019.8), so the Colab fallback and the Hugging Face upload carry public weather data only.
- If the target band is two or more bands from the rule band, the target includes a templated `disagreement_reason`, so the fine-tuned model passes AC-004.3.
- Target band: the band of the empirical success rate among similar forecasts, computed **from the training period (1 Apr–31 Aug 2026) only**; Sep–Oct hold-out data never contributes to any target or rate. Method: for each training row, candidates are the training rows of the same chore on other dates (the row's own date excluded); features are the rule's inputs for that chore's window (e.g. rain, max probability, max/min temperature, mean drying index), z-scored on the training period; Euclidean distance; k = 30 nearest (all, if fewer); rate = share of neighbours whose outcome label is true; band cut points at the midpoints between the band odds: rate ≥ 0.775 → very likely · ≥ 0.60 → likely · ≥ 0.425 → toss-up · ≥ 0.25 → unlikely · else very unlikely.
- Details of the neighbour method as built (T-011): ties in distance go to the earlier date; z-scores use the population standard deviation and a constant feature scores 0; an optional feature (the plants' maximum rain probability) that is missing in any training row of a chore is dropped for that chore and listed with the dataset counts, while a missing required feature skips that day; a training row whose outcome window reaches into 1 Sep (the 31 Aug rows of the overnight chores) is skipped, so no hold-out weather touches a label, feature or target; the day-1-lead value for hour H comes from a run issued at most 24 h before H (the lookahead check refuses any value issued at or after the decision time); all five chores get a row every day, whether or not the app offers the chore yet.
- Hold-out rows (1 Sep to the snapshot's last archive day, recorded in the manifest) keep their own outcome label for evaluation and are never targets.
- Manifest (AC-019.7): prompt version, `config/rules.json` hash, snapshot end date, synthetic habit profile, rows per chore and band. Chores with few rows (e.g. heater in Apr–Aug) are reported with their N.
- Target reason: templated from the forecast values (e.g. "6 mm of rain overnight; pots will be watered"), not generated by a model.
- The post describes it as "fine-tuning taught Gemma the local base rates".

## Open questions (design)
- [x] Q-13: Fine-tune labels: band of the similar-forecast success rate from Apr–Aug only, templated reasons (answered 2026-10-21, see Fine-tune dataset).

## Assumptions (design)
- A-12: The rule and safety thresholds above are final for this version, not tuned (Q-5 closed 2026-10-21).
- A-13: App port 8787.
- A-14: No encryption at rest beyond the OS account; the laptop is single-user.

## Traceability
| Requirement | Design section(s) |
|---|---|
| REQ-001 | Components (Pairing + session guard), Interfaces, Security design, ADR-0007 |
| REQ-002 | Gemma jobs (Listener), Interfaces |
| REQ-003 | Gemma jobs (Bookmaker), ModelClient, Interfaces, ADR-0005 |
| REQ-004 | Rule baseline, Data model (`quotes`, `bets`), ADR-0005 |
| REQ-005 | Photo store, Gemma jobs (Inspector), Data model (`bets.band_without_photo`) |
| REQ-006 | Ledger, bet state machine, Interfaces |
| REQ-007 | Web client (polling), Scheduler, Interfaces |
| REQ-008 | Gemma jobs (Judge), Scheduler, Weather service, ADR-0008 |
| REQ-009 | Points and savings |
| REQ-010 | Web client, Interfaces (settle) |
| REQ-011 | Points and savings, Data model (`savings_snapshot`) |
| REQ-012 | Safety backstop, Gemma jobs (Safety guard) |
| REQ-013 | Reliability (failure modes), Web client, Data model (`odds_source`) |
| REQ-014 | Weather service, Reliability, ADR-0008, ADR-0009 |
| REQ-015 | Data model, CLI, Security design (data protection) |
| REQ-016 | Rule baseline, Settle-time bounds, ADR-0009 |
| REQ-017 | Web client |
| REQ-018 | Backtest + eval, ADR-0008 |
| REQ-019 | Training, Backtest + eval, ADR-0006 |
| REQ-020 | Interfaces (`/api/score`), Web client |
| REQ-021 | Gemma jobs (Laundry planner), Feature flags |
| REQ-022–026 | Feature flags, Ledger, Scheduler, Web client |
| REQ-027 | ModelClient (llama.cpp), ADR-0004 |
| REQ-028 | Data model (`gemma_decisions`), Gemma jobs |
| REQ-029 | Feature flags |
| NFR-001 | Security design, ADR-0007 |
| NFR-002 | Security design (calls that leave the device, data protection), Photo store |
| NFR-003 | Scheduler, Reliability |
| NFR-004 | ModelClient, Testing strategy (live evals) |
| NFR-005 | Backtest + eval |
| NFR-006 | Weather service (cache), Cost estimate |
| NFR-007 | Reliability (observability) |
| NFR-008 | Environments (distribution), Security design |
| NFR-009 | Web client, Testing strategy (axe) |
| NFR-010 | ModelClient (Fake), Testing strategy |
| NFR-011 | Environments and deployment |
| NFR-012 | Backtest + eval, Training |

## Implementation decisions (2026-10-22)
Approved by the builder after the merge of T-003 to T-009 and T-011, so that this spec matches the merged code. The text above carries the details; this list says which task made each decision and which IDs it touches.

1. **Placing and undoing a bet** (T-004, T-008; REQ-006, AC-006.1, AC-006.3, AC-006.4, AC-006.5): `POST /api/bets` takes `{card_id, quote_id, kind}` and locks the quote the user saw; a quote that is no longer the card's latest, or whose settle time has passed, is refused with 409. The 5-minute undo window is inclusive: the boundary instant still counts. An undone bet keeps its row with status `undone`.
2. **Data model** (T-004, T-005, T-006, T-007, T-008, T-009; REQ-004, 005, 006, 008, 011, 028, NFR-003): `bets.reason`; the write-once `savings_snapshot`, `model_version`, `prompt_version` and `band_without_photo`, written in the INSERT and protected by the 0003 triggers; `cards.notice` (0004), with the Gemma and photo state columns of 0005 and 0006; `settle_progress` and `settlements.multiplier_capped` (0007); migrations numbered 0001 to 0007 as merged (see Data model).
3. **Card kinds** (T-005; AC-002.3, AC-014.4, AC-016.4, AC-016.5; [ADR-0009](../adr/0009-cards-without-odds-are-coming-later-cards-with-a-notice.md)): "No forecast, can't set odds", "Not needed this season" and "outside the offer window" are `coming_later` cards with a `notice`; AC-014.4 is a card with a notice (201), not a 503. The `heater` flag gates the AC chore too. The line-dry offer window is [07:00, 15:00). `SIB_FAKE_WEATHER=1` is for development.
4. **Outcome labels, targets and the dataset** (T-011; REQ-018, REQ-019, AC-018.1, AC-019.1, AC-019.5): target bands use the neighbour method with k = 30 and cut points 0.775 / 0.60 / 0.425 / 0.25, which this spec already stated (Fine-tune dataset); T-011 adds the 31 Aug skip, the issued-at-most-24-h-before day-1 value, the sunset hour in the window, the ET0-to-rain fallback, dropped optional features and one row per chore per day.
5. **Gemma jobs and cards** (T-006; REQ-002, 003, 004, 012, 013, NFR-007, NFR-010): the fake model runs only with `SIB_FAKE_MODEL=1` and `sib start` refuses to start without a configured Gemma tag; Ollama down reads "Gemma offline · rule odds"; the job queue holds 8, and when it is full the listener, Retry, Answer, settle and photo upload return 503 "Gemma is busy" before any state change while a quick card still gets rule odds marked busy; a card asks at most 2 questions and stores at most 3 answers; settle bounds are anchored on the card's `created_at`; the safety backstop is re-checked on the final settle window; an answer that arrives after a bet was placed is `superseded`; `tool_mode = called` only after a valid `get_forecast` call.
6. **Photos and deletion** (T-007; REQ-005, REQ-015, AC-005.2, AC-005.4, AC-005.6, AC-015.2): deleting a bet's data deletes its whole card, plus that card's other undone bets, unless a newer active bet exists; the photo-unsure question is text only, has no tap answers and does not count toward the question cap; a new before photo replaces the earlier one with its quotes and decisions; one upload is processed at a time; accepted formats are JPEG, PNG, WebP and HEIF by magic bytes with other decoders blocked; photos are written as `.tmp` then renamed, with an orphan sweep at start.
7. **Settlement and data commands** (T-009; REQ-008, 009, 011, 015, AC-008.5 to AC-008.8, AC-011.5, AC-011.6, AC-015.3, AC-015.4): AC-008.8 stays literal: a verdict committed at or after settle_at + 24 h pays a win at ×0.5 whatever the evidence, the evidence is kept and `multiplier_capped` marks the row; answers 24 h or more late are refused with 409 and the bet settles from the weather record; an open judge question is cleared after 24 h; the judge asks at most 2 questions and failed Gemma tries repeat every 2 min; `lucky_win` uses the chore's full fixed outcome window, cut only at the end; weekly totals are attributed by the bet's `settle_at`; do-it settlements are stored with evidence `auto` and multiplier 1, so readers of `auto` filter by bet kind; the savings backfill uses today's baseline and the condenser-dryer figure is labelled "typical estimate"; `sib delete-photos --all-data` and `sib export` refuse while the app is running (exclusive SQLite lock) and delete only the files the app owns (`sib.db`, `-wal`, `-shm`, photo files); export refuses symlinks and non-empty folders.
8. **Server config** (T-003; REQ-001, AC-001.3, AC-001.9): `config/server.json` (git-ignored) holds `publicOrigins`, `allowedHosts` and the port; `/healthz` needs a session.
