# Tasks: Should I Bother?

- Status: Approved (2026-10-21) <!-- Draft | In review | Approved -->
- Last updated: 2026-10-21

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.
Order = implementation order. Each task is a small vertical slice (≤ ~1 day), references
the requirements it serves, and has an objective "Done when".

**Who**: **Agent** = cloud or local agent session working on the fake model and recorded fixtures, no GPU needed · **Builder** = needs the laptop GPU, the phone, a merge or a human decision. At most 2 agent workers (W1, W2) in parallel, each in its own worktree or cloud session.

**Branching and merging**:
- The builder is the only one who merges, and is away in the mornings. Agents therefore **stack PRs**: each task branches from the previous task's branch in its worker's stack (the first task of a stack branches from `docs/spec` on Wed night, or from `main` after it has been merged), and its PR targets that parent branch.
- Every builder slot starts with **review and merging, in stack order** (W1 stack first, then W2): **~90 min on Thu PM** (six PRs including the auth module, T-003) and **~90 min on Fri PM** (six PRs plus checking migrations on a copy of the live database); ~45 min on Sat. After a parent merges, the child PR is retargeted to `main` and rebased if needed.
- Agent sessions for the Thursday-morning slot are **started Wed 21 night** (cloud sessions with task briefs, or scheduled for Thu 08:00 Madrid), branching from `docs/spec`. Later agent slots are started by the builder at the end of the previous builder slot.
- Each brief names the task ID, the requirement IDs, the parent branch, the assigned migration number and the files in scope.

**Migrations** (assigned to avoid clashes between parallel workers): 0001 pairing + sessions (T-003) · 0002 core schema: cards, quotes, bets, settlements, photos, gemma_decisions, weather_cache (T-004) · 0003+ in the order tasks merge, number given in the task brief.

**Freeze rule**: feature freeze Sat 24 Oct 14:00 Madrid. A task not done by then stays behind its flag (REQ-029), off by default, and goes in the post as "next".

**Hard checkpoint**: T-002–T-006 and T-008 merged during the Thu PM slot, so the builder places the first real bet from the phone on Thu evening (T-010; first bet without a photo, since photos arrive with T-007 on Friday).

## Schedule
| Slot (Madrid) | Builder | Agents (≤ 2 workers, stacked PRs) |
|---|---|---|
| Wed 21 night | Finish Phase 5, approve spec; `ollama pull` Gemma 4 E4B + E2B; start Thu AM agent sessions | — |
| Thu AM | (away) | W1: T-002 → T-003 → T-004 → T-008 → T-005 → T-006 · W2: T-011 (snapshot code + outcome labels, fixture-based; only `src/domain/outcomes.ts`, `src/backtest/**` and their tests) |
| Thu PM | Merge (~90 min: W1 stack, then T-011), running the T-001 spikes while reviewing · T-010 real Gemma, phone, freeze `bookmaker.vN`, first real bets in the evening · T-031 real snapshot + JSONL (needs T-005 merged and the frozen prompt) · then `ollama stop` and start T-012 · start Thu-night agents | — |
| Thu night | T-012 training runs unattended (Ollama stopped; Gemma shows offline) | W1: T-007 → T-009 |
| Fri AM | (away) | W1: T-013 → T-016 (stacked on T-009) · W2: T-015 → T-029 |
| Fri PM | Merge (~90 min: T-007, T-009, T-013, T-016, T-015, T-029; migrations checked on a copy of the live DB first) · settle Thursday's bets · T-030 photo eval · T-014 fine-tune eval · start T-019 and the Fri-night agents | — |
| Fri night | T-019 backtest runs unattended (E4B, E2B, rule, fixed routine; fine-tuned column from T-014), paused from 07:00 | W1: T-017 → T-018 · W2: T-022 → T-023 → T-024 (flagged) |
| Sat (until 14:00) | Merge Fri-night PRs · T-019 reports · T-020 release readiness · freeze 14:00 | W2 continues Milestone 5 in order only if review time allows |
| Sat (14:00–23:00) | T-021 video, post numbers, publish by 23:00 | — |

## Slot per task
| Task | Thu AM agents | Thu PM me | Thu night | Fri AM agents | Fri PM me | Fri night | Sat |
|---|---|---|---|---|---|---|---|
| T-001 Spikes | | ● | | | | | |
| T-002 Toolchain | ● W1 | merge | | | | | |
| T-003 Pairing | ● W1 | merge | | | | | |
| T-004 Walking skeleton | ● W1 | merge | | | | | |
| T-005 Weather, rules, backstop | ● W1 | merge | | | | | |
| T-006 Gemma jobs, listener, bookmaker | ● W1 | merge | | | | | |
| T-007 Photos, inspector | | | ● W1 | | merge | | |
| T-008 Bets, undo, Slips | ● W1 | merge | | | | | |
| T-009 Settlement, points, savings, export/delete-all | | | ● W1 | | merge | | |
| T-010 Real Gemma + phone | | ● | | | | | |
| T-011 Snapshot code + outcome labels | ● W2 (fixtures) | merge | | | | | |
| T-031 Real snapshot + dataset JSONL | | ● | | | | | |
| T-012 Fine-tune | | start | ● unattended | | | | |
| T-013 Safety guard, laundry tonight | | | | ● W1 | merge | | |
| T-014 Fine-tune eval | | | | | ● | | |
| T-015 Backtest harness | | | | ● W2 | merge | | |
| T-016 Score | | | | ● W1 | merge | | |
| T-017 Stamp animation | | | | | | ● W1 | merge |
| T-018 UI polish, a11y | | | | | | ● W1 | merge |
| T-019 Live eval + backtest | | | | | start | ● unattended | reports |
| T-020 Release readiness | | | | | | | ● before 14:00 |
| T-021 Video, post | | | | | | | ● after 14:00 |
| T-022–T-024 | | | | | | ● W2 | merge if reviewed by 14:00 |
| T-025–T-028 | | | | | | | W2 only if time; else "next" |
| T-029 Post skeleton | | | | ● W2 | merge | | |
| T-030 Photo eval on real Gemma | | | | | ● | | |

## Milestone 1: Spikes and walking skeleton
Walking skeleton = paired phone → quick chip "Water plants" → rule odds → bet → tap settle (fake judge) → points, CI green on the PR.

- [ ] T-001: Day-1 spikes (time-box 2 h)
  - Who / when: Builder · Thu 22 afternoon
  - Requirements: NFR-004, NFR-011, REQ-005, REQ-018, REQ-019; assumptions A-1–A-4; ADR-0004, ADR-0008
  - Depends on: — (agent tasks run on the fake meanwhile; only T-010 and T-012 wait for it)
  - Scope: throwaway scripts in `spikes/` (not shipped): (1) E4B photo + forecast → JSON via Ollama with a JSON schema and a `get_forecast` tool call, 20 tries; (2) phone upload with `<input type="file" accept="image/*" capture="environment">` over plain HTTP via WSL mirrored networking (or netsh portproxy, then check the Host allowlist with `config.allowedHosts` and that the rate limit sees the Windows host address) + Windows firewall rule, including a real iPhone photo (HEIC → sharp?); (3) Previous Runs (day-1 lead) + Historical Forecast + archive + forecast past-hours calls for Gràcia, Apr–Oct 2026, variables listed in design.md, including `et0_fao_evapotranspiration` in the archive (plants outcome label) and the archive's last available day; (4) QLoRA 10 steps on E4B fits in VRAM and the merged model converts to GGUF and loads in Ollama; (5) if (1) fails with tools + JSON schema together, try two steps (tool call, then schema-constrained answer), then the injected-forecast fallback (design.md, Bookmaker).
  - Done when: each check has pass/fail with numbers (latency per call, valid-JSON count out of 20, tool-call count, VRAM peak, HEIC result, variables present) recorded in `docs/spec/progress.md`; ADR-0004 and ADR-0008 updated with results and set to Accepted or revised; `config/models.json` has Ollama tags, quantization and digests; every failed check has its fallback written into the affected task (text-only odds / two-step or injected-forecast tool use / Tailscale Serve / perfect-forecast upper bound / rain-only plants label / Colab).

- [x] T-002: Toolchain, Node 24 pin and project layout
  - Who / when: Agent W1 · Thu AM (started Wed night, branches from `docs/spec`)
  - Requirements: NFR-010, NFR-011, NFR-001 (audit), REQ-029
  - Depends on: —
  - Scope: `.nvmrc` = 24; `engines` `>=24 <25`; `.github/workflows/ci-node.yml` `node-version: 24`; new CI job for `training/` (ruff + pytest, no GPU, no network) with a placeholder test; dependencies (fastify, react, react-dom, vite, zod, better-sqlite3, sharp, pino) pinned in the lockfile; layout `src/server/`, `src/web/`, `src/domain/`, `src/cli.ts`, `prompts/`, `config/` (`flags.json`, `rules.json`, `household.json`, `models.json`), `test/fixtures/gemma/`; feature-flag loader; `data/` and the data folder git-ignored; scripts `dev`, `start`, `build`.
  - Done when: `npm ci && npm run lint && npm run typecheck && npm test && npm run build` pass on Node 24; CI green on the PR (Node and Python jobs); a test proves a flag that is off registers no route (AC-029.1, AC-029.2); `npm audit --audit-level=high` clean.

- [x] T-003: Pairing and session guard
  - Who / when: Agent W1 · Thu AM (stacked on T-002)
  - Requirements: REQ-001, NFR-001, NFR-007; ADR-0007
  - Depends on: T-002
  - Scope: migration 0001; 10-min token generation at start and via `sib pair` + QR/URL print; `/pair` exchange and redirect (≤ 3 devices per token, console line per pairing); 30-day sessions; session guard on all routes except `/pair`; Origin check against the app's own origins incl. `config.publicOrigins`; Host allowlist built at start-up from active interfaces + `config.allowedHosts` + public-origin hosts (421 otherwise); `Secure` cookie when pairing over an https public origin; rate limit on unauthenticated failures only; `sib forget-devices`; security headers incl. CSP `default-src 'self'; img-src 'self' blob: data:`; log redaction; bind to 127.0.0.1 + LAN address only.
  - Done when: integration tests for AC-001.1–AC-001.10 pass (401 without session on page, API and photo routes; 403 on bad/missing Origin and 2xx on a `config.publicOrigins` origin; 421 on a Host not in the allowlist; a 4th device on one token refused; rate limit after more than 10 unauthenticated failures while a valid session keeps working; the `/pair?token=` request log line contains no token); `security-auditor` review has no open Blockers.

- [x] T-004: Walking skeleton: plants bet end to end on the fake
  - Who / when: Agent W1 · Thu AM (stacked on T-003)
  - Requirements: REQ-004 (plants rule only), REQ-006 (AC-006.1 minimal), REQ-008 (tap only), REQ-009, REQ-013 (rule-odds path); NFR-003, NFR-010
  - Depends on: T-003
  - Scope: migration 0002 (core schema); `ModelClient` interface + `FakeModelClient` (fixtures by job + scenario name, hand-written synthetic until T-010 records real ones); fake weather client; plants rule band; quick chip "Water plants" → card with rule odds → minimal bet insert → scheduler marks due → tap answer → fake judge verdict → points; minimal SPA (Today with chip and card, a bare list of due bets, settle tap) using design tokens. Undo, do-it, the state machine and the Slips screen belong to T-008.
  - Done when: one integration test drives the whole flow with a fake clock; unit tests for payout rounding and loss points (AC-009.1–AC-009.4); restart test: an open bet survives a server restart and settles (NFR-003); `npm run dev` shows the flow in a phone-width browser; CI green.

## Milestone 2: Core loop with real Gemma (tiers 1–2)
- [x] T-005: Weather service, all rules and the safety backstop
  - Who / when: Agent W1 · Thu AM (stacked on T-008); merged Thu PM
  - Requirements: REQ-004, REQ-012 (AC-012.1, AC-012.2), REQ-014 (incl. AC-014.7), REQ-016 (AC-016.1, AC-016.4, AC-016.5); NFR-002, NFR-006; ADR-0008
  - Depends on: T-004, T-008
  - Scope: Open-Meteo client (forecast, past hours) with timeout, retry, 1 h cache, coordinates rounded to 2 decimals, call counter and the host allowlist; rule bands in `src/domain/rules` for plants, line-dry today, laundry tonight, AC and heater exactly as the design table (first match wins); drying index; "Line-dry today" offer window and "Not needed this season" for AC/heater from `config/household.json`; safety backstop; final thresholds in `config/rules.json`; "Do it now" alert card with no bet action; forecast age display; attribution in the app.
  - Done when: unit tests per rule band edge (both sides of every half-open bound) and backstop limit; integration tests for AC-012.1, AC-012.2, AC-014.1–AC-014.7 (a request to a non-allowlisted host is refused) and AC-016.4, AC-016.5 with a fake HTTP server (no network in tests); rule odds appear ≤ 1 s after capture (AC-004.1, timed in test).

- [x] T-006: Gemma jobs framework, listener and bookmaker
  - Who / when: Agent W1 · Thu AM (stacked on T-005); merged Thu PM
  - Requirements: REQ-002, REQ-003 (incl. AC-003.6), REQ-004 (AC-004.2, AC-004.3), REQ-013, REQ-028; NFR-004 (timeout), NFR-007; ADR-0005
  - Depends on: T-005
  - Scope: job runner (prompt template, zod schema → JSON schema, validate, retry once with the error, 30 s per call and 45 s per job, tool loop ≤ 2 calls, tool-use enforcement); `prompts/listener.v1.md`, `prompts/bookmaker.v1.md`; `gemma_decisions` logging; typed capture → cards; provisional rule odds → Gemma odds swap; "unsure" question as tap answers; Gemma offline/timeout label + Retry; Gemma status on Today; odds with plain words.
  - Done when: integration tests on fixtures for AC-002.1–AC-002.5, AC-003.1–AC-003.6, AC-004.2, AC-004.3, AC-013.1–AC-013.5, AC-028.2, including invalid JSON, no tool call, ≥ 2-band disagreement without explanation, and timeout fixtures.

- [x] T-007: Photos and the inspector
  - Who / when: Agent W1 · Thu night (branches from `main` after the Thu PM merges); merged Fri PM
  - Requirements: REQ-005 (incl. AC-005.6), REQ-015 (AC-015.1, AC-015.2), REQ-028 (AC-028.1); NFR-002
  - Depends on: T-004, T-006
  - Scope: multipart upload ≤ 10 MB; sharp decode/auto-rotate/re-encode JPEG ≤ 1024 px without metadata; 415 problem+json for unsupported formats; UUID filenames; authenticated `/photos/:id`; inspector job + `prompts/inspector.v1.md`; "What Gemma saw" and odds before → after; band without photo stored on the bet; delete photo / bet data.
  - Done when: any new migration is tested on a seeded fixture database and keeps existing rows (NFR-003; the builder repeats the check on a copy of the live database at merge); tests prove stored photos have no EXIF/GPS and longest side ≤ 1024 (AC-005.1); a deleted photo's row, its quotes and the inspector decisions that used it are unrecoverable from the DB file after the WAL checkpoint (AC-015.2); a non-image and an unsupported format return 415 with the message and the card unchanged (AC-005.6); fixtures cover AC-005.2–AC-005.5; delete removes the file (AC-015.2).

- [x] T-008: Bets, undo and Slips
  - Who / when: Agent W1 · Thu AM (stacked on T-004); merged Thu PM
  - Requirements: REQ-006, REQ-007, REQ-012 (AC-012.2 on the API, once T-005 adds alerts); NFR-003
  - Depends on: T-004
  - Scope: owns REQ-006 and REQ-007 in full: place bet locks quote fields; "I'll do it" decision; undo ≤ 5 min (409 after); bet state machine; Slips with Settle now (settle_at ≤ now at read time) / Waiting / Settled, countdowns, empty states; 30 s polling while visible.
  - Done when: tests for AC-006.1–AC-006.5 (incl. forecast change after placing leaves the bet unchanged), AC-007.1–AC-007.3 with a fake clock; locked columns cannot be updated (test).

- [x] T-009: Settlement with the judge, points, receipt and savings
  - Who / when: Agent W1 · Thu night (stacked on T-007); merged Fri PM
  - Requirements: REQ-008, REQ-009, REQ-010, REQ-011, REQ-015 (AC-015.3, AC-015.4), REQ-016 (settle rules for plants and line-dry today), REQ-028 (AC-028.1)
  - Depends on: T-006, T-007, T-008
  - Scope: judge job + `prompts/judge.v1.md`; settle by photo (with before photo) or tap; recorded weather from forecast past hours ("modelled recent weather"); unsure → question; lucky win computed from `src/domain/outcomes.ts` (T-011); auto-settle at +24 h ×0.5; `awaiting_gemma` and `awaiting_weather` with retries; do-it settlement; savings snapshot at bet time from `config/household.json`; weekly totals and net time; PAID OUT receipt (static stamp); loss screen with fixed copy strings; `sib delete-photos [--all-data]` with confirmation and `sib export <dir>` (JSON + photos).
  - Done when: tests for AC-008.1–AC-008.9, AC-009.1–AC-009.4, AC-010.1–AC-010.2, AC-011.1–AC-011.6, AC-015.3, AC-015.4 on fixtures and a fake clock, including Gemma offline at settle time (never settled by the rule) and a lucky win counted as a success; any new migration tested on a seeded fixture database with open bets (the builder repeats it on a copy of the live database at the Fri PM merge, so Thursday's open bets survive, NFR-003).

- [ ] T-010: Wire real Gemma and go live on the phone
  - Who / when: Builder · Thu PM, first real bet Thu evening (after merging T-002–T-006 and T-008)
  - Requirements: REQ-002, REQ-003, REQ-005, REQ-013, REQ-028; NFR-002, NFR-004, NFR-011
  - Depends on: T-001, T-006, T-008
  - Scope: `OllamaClient` (images, tools, JSON schema, per-call timeout and job deadline, warm-up at start); prompt tuning on the real model, then **freeze `prompts/bookmaker.vN.md`** for the dataset (T-031); Ollama `keep_alive` set long for the live week; record fixtures from real answers to **staged or synthetic inputs only** (no real household text or photos), keyed by job + scenario, reviewed by hand, into `test/fixtures/gemma/`; `sib eval <job>` with 20-case sets for listener and bookmaker (text); pair the phone over LAN; place the first real bets. The inspector and photo latency are T-030.
  - Done when: `sib eval` reports ≥ 19/20 valid JSON and tool-call use for listener and bookmaker (or the T-001 fallback is applied and recorded); fixtures re-recorded, reviewed and CI green; first real bet placed from the phone; `ss -ltnp` shows Ollama on 127.0.0.1 only (NFR-001).

- [x] T-011: Weather snapshot code and outcome labels
  - Who / when: Agent W2 · Thu AM (branches from `docs/spec`), written and tested against synthetic Open-Meteo fixtures (cloud sessions can't reach Open-Meteo). Touches only `src/domain/outcomes.ts`, `src/backtest/**` and their tests; no new dependencies and no CLI wiring (it exports functions; T-031 adds `sib snapshot` and `sib dataset` to `src/cli.ts`).
  - Requirements: REQ-018 (AC-018.1, AC-018.2, AC-018.4), REQ-019 (AC-019.1, AC-019.5), REQ-008 (AC-008.6 label function); NFR-012; ADR-0008
  - Depends on: —
  - Scope: snapshot functions that fetch Previous Runs day-1-lead forecasts (decisions; Historical Forecast as labelled fallback) and the archive incl. ET0 (outcomes) for Gràcia, 1 Apr 2026 to the archive's last day, into `data-snapshots/` with attribution and the end date; outcome label functions per chore exactly as design.md (Outcome labels), with the fixed decision times; the neighbour-based target-band function (design.md, Fine-tune dataset) over Apr–Aug only; train/hold-out split.
  - Done when: unit tests for every outcome label at its bounds; tests prove no hold-out date appears in training or influences any target (AC-019.1, AC-019.5) and that a row's own date is never its neighbour; a lookahead test fails if a decision uses a model run that started after the chore's decision time (AC-018.1); fallback sources are labelled (AC-018.2); re-running from a fixture snapshot gives identical output (NFR-012).

- [ ] T-031: Real snapshot and fine-tune dataset
  - Who / when: Builder · Thu PM, after T-005 and T-011 are merged and T-010 has frozen `prompts/bookmaker.vN.md`; before T-012
  - Requirements: REQ-019 (AC-019.1, AC-019.6, AC-019.7, AC-019.8); NFR-002, NFR-012
  - Depends on: T-005, T-006, T-010, T-011
  - Scope: wire `sib snapshot` and `sib dataset` into `src/cli.ts`; run the real snapshot on the laptop; build JSONL rows as the full live bookmaker conversation (frozen prompt, chore, the fixed synthetic habit profile, rule band from `src/domain/rules`, `get_forecast` call + result), target band from T-011, templated reason and `disagreement_reason`; hold-out file kept apart; manifest.
  - Done when: a test fails the build if any value from `config/household.json` appears in a row (AC-019.8); rows match the live bookmaker prompt format and carry a disagreement reason where required (AC-019.6); the manifest has prompt version, `rules.json` hash, snapshot end date, habit profile and rows per chore and band (AC-019.7); re-running from the snapshot yields byte-identical JSONL (NFR-012); the real JSONL exists on the laptop before T-012 starts.

- [ ] T-012: Fine-tune the bookmaker (QLoRA)
  - Who / when: Builder starts it at the end of Thu PM, after placing the evening's bets and running `ollama stop` (design.md, GPU and model residency); runs unattended Thu night
  - Requirements: REQ-019 (AC-019.2, AC-019.4); NFR-012; ADR-0006
  - Depends on: T-001 (smoke run), T-031
  - Scope: `training/` uv project (pinned), training script (Unsloth or TRL + PEFT, fixed seed), merge, GGUF conversion, Ollama Modelfile import as a pinned local tag; ruff + pytest for dataset loading and config; flag `finetunedBookmaker` off by default.
  - Done when: training finishes and the merged GGUF loads in Ollama and answers the bookmaker schema on 20 hold-out prompts with ≥ 19/20 valid JSON; model tag and digest in `config/models.json`; CI Python job green. If training fails by Fri 12:00, the flag stays off and the post reports it.

## Milestone 3: Tier 3–4 (Fri)
- [ ] T-013: Gemma safety guard and "Leave it out tonight"
  - Who / when: Agent W1 · Fri AM (stacked on T-009); merged Fri PM
  - Requirements: REQ-012 (AC-012.3, AC-012.4), REQ-016 (AC-016.2)
  - Depends on: T-005, T-006, T-009
  - Scope: safety guard job + `prompts/safety.v1.md`; alert card from Gemma; backstop still applies when Gemma is down; laundry "Leave it out tonight" offer, rules and settlement.
  - Done when: fixture tests for AC-012.3, AC-012.4, AC-016.2; flags `safetyGuard`, `laundryTonight`.

- [ ] T-014: Evaluate the fine-tune (base vs fine-tuned)
  - Who / when: Builder · Fri PM (after merging T-015)
  - Requirements: REQ-019 (AC-019.3); NFR-012
  - Depends on: T-012, T-015
  - Scope: run the backtest evaluation on the Sep–Oct hold-out for base and fine-tuned E4B; band calibration with N, Brier score, tool-call miss rate; write `docs/results/finetune.md`.
  - Done when: report committed with model digests, prompt versions and seeds; re-run reproduces the numbers (NFR-012); decision recorded on whether `finetunedBookmaker` is on for the live app.

- [x] T-015: Backtest harness
  - Who / when: Agent W2 · Fri AM (branches from `main`); merged Fri PM; live run in T-019
  - Requirements: REQ-018 (AC-018.1–AC-018.4), REQ-019 (AC-019.3 harness); NFR-005, NFR-012
  - Depends on: T-005, T-006, T-011
  - Scope: `sib backtest` over the snapshot: strategies rule, fixed routine, Gemma E2B, E4B base, E4B fine-tuned (via `ModelClient`; T-014 uses it on the hold-out); per-day decisions at each chore's fixed decision time from day-1-lead forecasts only; outcomes from the outcome labels (T-011); fixed routine calibration reported as n/a; headline numbers on Sep–Oct, Apr–Aug labelled in-sample for the fine-tuned model and the rule thresholds; report (skips, chores avoided, time/water/kWh, plant-risk days, calibration with N per band, Brier, tool-call miss rate) as Markdown + JSON; resumable, progress output, `--pause-at 07:00`; prints an estimate (calls × measured latency) per model before starting.
  - Done when: runs end to end on the fake model in CI on a 2-week slice; a lookahead test fails if any decision uses data from a model run that started after the decision time; the in-sample/hold-out split is visible in the report; output format reviewed.

- [ ] T-016: Score screen
  - Who / when: Agent W1 · Fri AM (stacked on T-013); merged Fri PM
  - Requirements: REQ-020, REQ-011 (Score tiles); NFR-009
  - Depends on: T-009
  - Scope: `/api/score`; points, savings tiles with net-time note, judge overrule rate with N ("appeals off" until T-024's flag is on), calibration chart Gemma vs rule with N per band and "too few to judge" under 5, over the populations in AC-020.2, with the lucky-win share; empty state; flag `score`.
  - Done when: tests for AC-020.1–AC-020.4; axe check passes on the screen.

- [ ] T-017: PAID OUT stamp animation
  - Who / when: Agent W1 · Fri night (branches from `main` after the Fri PM merges); merged Sat AM
  - Requirements: REQ-017
  - Depends on: T-009
  - Scope: stamp animation (scale 1.6 → 1, −8°, 220–280 ms) with reduced-motion fade; flag `stampAnimation`. (Export and delete-all moved to T-009: they are Must.)
  - Done when: component tests for AC-017.1 and AC-017.2 (reduced motion → no transform animation).

- [ ] T-018: UI polish to the Figma design and accessibility pass
  - Who / when: Agent W1 (`ui-designer`, then `ux-reviewer`) · Fri night (stacked on T-017); merged Sat AM
  - Requirements: NFR-009, REQ-003 (AC-003.5), REQ-010, REQ-028 (AC-028.1)
  - Depends on: T-009
  - Scope: Today, bet sheet, Slips, Settle, receipt to the mockups in `docs/images/` with `docs/design/tokens.css` (+ `ink-3-text`, `amber-text`); empty/loading/error states; touch targets ≥ 44 px; Lucide icons; self-hosted fonts; mismatches from design-handoff §6 fixed (no "Bedding", Gemma runs on your computer).
  - Done when: `ux-reviewer` reports no Blockers; axe passes on all core screens; Playwright e2e capture → bet → settle at phone width passes; production build screens interactive ≤ 3 s on the phone over home Wi-Fi (NFR-004, checked by the builder Sat AM).

## Milestone 4: Results and release
- [ ] T-019: Live evaluation and backtest run
  - Who / when: Builder starts it at the end of Fri PM; the backtest (E4B, E2B, rule, fixed routine) runs unattended Fri night; reports written Sat AM
  - Requirements: REQ-018, REQ-005 (photo ablation), NFR-004, NFR-005
  - Depends on: T-010, T-015 (T-014 for the fine-tuned column)
  - Scope: run `sib backtest` with real models unattended Fri night, paused from 07:00 so morning settlements get the GPU; photo ablation on live bets (band with vs without photo vs outcome); the fine-tuned column taken from T-014's hold-out report (not re-run); rule thresholds are the final A-12 values (no tuning); latency and valid-JSON re-measured on the live build; `docs/results/backtest.md`, `docs/results/live-week.md`.
  - Done when: reports committed with N everywhere, model digests, and the in-sample (Apr–Aug) vs hold-out (Sep–Oct) split; fine-tuned results headlined on Sep–Oct only; backtest ≤ 8 h (NFR-005); the report lists the `config/rules.json` values used.

- [ ] T-020: Release readiness
  - Who / when: Builder (agent drafts the README) · Sat before 14:00
  - Requirements: NFR-001, NFR-002, NFR-008, NFR-011; REQ-014 (AC-014.6)
  - Depends on: T-010
  - Scope: README (what, setup on WSL2, Ollama + model pull with digests, mirrored networking + firewall, pairing, Tailscale Serve option and the plain-HTTP limit, licences, Open-Meteo attribution, later-commit note); network capture during one capture → settle cycle; fresh-clone run-through; **Q-9 rules check** on the Week 3 rules page (repo window, licence); Q-11 adapter published on Hugging Face (builder, by hand); flags for unfinished features off; **repo made public** by the builder.
  - Done when: network capture shows only Open-Meteo hosts (NFR-002); fresh clone to running app ≤ 30 min excluding model download (NFR-011); Q-9 closed with what the rules page says; `/review-all` on the final diff has no open Blockers; repo is public (builder) before the post is published.

- [ ] T-021: Demo data, video and post assets
  - Who / when: Builder · Sat 24 14:00–23:00
  - Requirements: G-1 (success metrics in product.md)
  - Depends on: T-009 (`sib export`), T-019, T-020, T-029
  - Scope: `sib export` of the live week; screenshots; 60–90 s video; fill the T-029 skeleton with numbers from `docs/results/`; photos checked by hand before publishing.
  - Done when: ≥ 8 settled live bets, ≥ 3 by photo, ≥ 2 chore types counted from the export (or the shortfall stated in the post); post published by Sat 24 Oct 23:00 Madrid.

- [x] T-029: Post skeleton
  - Who / when: Agent W2 · Fri AM (stacked on T-015); merged Fri PM
  - Requirements: G-1, G-4 (success metrics in product.md)
  - Depends on: —
  - Scope: `docs/post/draft.md` following the official challenge template headings (What I Built, Demo, Code, How I Built It, Why Does Open Innovation Matter?, My Agent Session, The Lazy Payoff, Prize Categories) with `{{placeholders}}` for every number, each linked to the `docs/results/` file and metric it comes from; Mermaid architecture diagram from design.md; assumptions table for savings; "fine-tuning taught Gemma the local base rates" section; Open-Meteo attribution; no invented numbers.
  - Done when: every placeholder names its source file and metric; diagram renders; the draft contains no home photos and no figures that aren't placeholders.

- [ ] T-030: Photo evaluation on real Gemma
  - Who / when: Builder · Fri PM (after merging T-007)
  - Requirements: REQ-005, NFR-004
  - Depends on: T-007, T-010
  - Scope: `sib eval inspector` and photo bookmaker on a 20-case staged photo set; `sib eval judge` on 20 staged cases (before/after photos and taps); `sib eval safety` on 20 synthetic cases if T-013 is merged; record fixtures from staged photos only (no home photos), keyed by job + scenario, reviewed by hand.
  - Done when: ≥ 19/20 valid JSON for the inspector, the judge (and the safety guard if merged), and photo judgement (inspector + bookmaker) ≤ 15 s in ≥ 19/20 (NFR-004), or the T-001 fallback (text-only odds) is applied and recorded.

## Milestone 5: Tier 5–6 (only before the freeze, each behind a flag)
Taken in this order by agent W2 from Fri night; anything not merged by Sat 14:00 stays off.
- [ ] T-022: Laundry planner — REQ-021 · Depends on: T-006, T-009 · Done when: fixture tests for AC-021.1–AC-021.5; flag `laundryPlanner`.
- [ ] T-023: Rescue alerts and cash-out — REQ-022 · Depends on: T-009 · Done when: tests for AC-022.1–AC-022.2 with a fake clock; flag `rescue`.
- [ ] T-024: Appeals — REQ-023 · Depends on: T-009, T-016 · Done when: tests for AC-023.1–AC-023.3; overrule rate on Score counts appeals; flag `appeals`.
- [ ] T-025: Onboarding and habit baseline — REQ-024 · Depends on: T-009 · Done when: tests for AC-024.1–AC-024.2; flag `onboarding`.
- [ ] T-026: Ranks, achievements and the heater bet — REQ-025, REQ-016 (AC-016.3) · Depends on: T-016 · Done when: tests for AC-025.1–AC-025.2, AC-016.3; flags `ranks`, `heater`.
- [ ] T-027: Split-flap weather board — REQ-026 · Depends on: T-005 · Done when: component tests for AC-026.1–AC-026.2; flag `splitFlap`.
- [ ] T-028: Voice capture through Gemma 4 audio — REQ-027 · Depends on: T-006, T-010 · Scope: llama.cpp client on 127.0.0.1; whisper.cpp fallback stated in the post · Done when: tests for AC-027.1–AC-027.3 on fixtures; a live voice note produces cards on the laptop; flag `voice`.

## Coverage check
| Requirement | Tasks |
|---|---|
| REQ-001 | T-003 |
| REQ-002, REQ-003 | T-006, T-010 |
| REQ-004 | T-004, T-005, T-006 |
| REQ-005 | T-007, T-019, T-030 |
| REQ-006, REQ-007 | T-004, T-008 |
| REQ-008–REQ-011 | T-004, T-009 (AC-008.6 label: T-011) |
| REQ-012 | T-005, T-013 |
| REQ-013 | T-004, T-006 |
| REQ-014 | T-005 |
| REQ-015 | T-007, T-009 |
| REQ-016 | T-005, T-009, T-013, T-026 |
| REQ-017 | T-017 |
| REQ-018 | T-011, T-015, T-019 |
| REQ-019 | T-011, T-031, T-012, T-014 |
| REQ-020 | T-016 |
| REQ-021–REQ-027 | T-022–T-028 |
| REQ-028 | T-006, T-007, T-009, T-010 |
| REQ-029 | T-002 |
| NFR-001 | T-002, T-003, T-010, T-020 |
| NFR-002 | T-005, T-007, T-031, T-020 |
| NFR-003 | T-004, T-008 |
| NFR-004 | T-001, T-010, T-018, T-019, T-030 |
| NFR-005 | T-015, T-019 |
| NFR-006 | T-005 |
| NFR-007 | T-003, T-006 |
| NFR-008 | T-020 |
| NFR-009 | T-016, T-018 |
| NFR-010 | T-002, T-004 |
| NFR-011 | T-001, T-002, T-020 |
| NFR-012 | T-011, T-031, T-012, T-014, T-019 |
| G-1 (post) | T-020, T-021, T-029 |
