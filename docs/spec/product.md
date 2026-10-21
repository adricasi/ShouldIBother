# Product: Should I Bother?

- Status: Draft <!-- Draft | In review | Approved -->
- Last updated: 2026-10-21
- Inputs: [idea brief](../discovery/idea-brief.md) (verdict: Go with a cut scope), [product concept](../discovery/product-concept.md) (catalogue, points, settlement, savings rules), [design handoff](../discovery/design-handoff.md) (screens, tokens), [research notes](../discovery/research-notes.md). Where they disagree, this spec wins.

## Problem
Many weather chores are done out of habit, not need: watering balcony pots the evening before rain, running the tumble dryer on a sunny, breezy day, switching on the AC when a night breeze would cool the flat. The weather would have done the job, but nobody checks, because checking takes judgement: a forecast says "20% rain", not "this basil can wait until Thursday".

Should I Bother? ("The Lazy Bookie") is a local Gemma 4 bookmaker. It turns each chore into a bet on doing nothing, judges *this* plant, *this* load and *this* evening from a photo plus the forecast, and settles every bet on evidence: recorded weather plus an after photo or a one-tap answer. Correct laziness earns points and measured savings (net time, water, electricity); wrong laziness costs points.

It is also an entry for the DEV Hacktoberfest Open-Source AI Challenge, Week 3 "Slow and Steady" (rewarding laziness with open-source AI), targeting **Overall** and **Best Use of Gemma**. Writing quality is weighted most.

## Users and personas
| Persona | Needs | Current pain |
|---|---|---|
| Balcony household (first user: the builder's flat in Gràcia, Barcelona) | Know when to skip watering, the dryer or the AC, and see whether skipping was right | Habit and a glance at a weather app; no judgement about the specific item, no feedback on waste |
| Challenge judge / DEV reader | A clear, honest story of Gemma doing real judgement locally, with measured results | Many "sloth" entries; local Gemma alone does not stand out |
| Developer running it locally (from the public repo) | Clone, download the model, run on their own laptop + phone | Setup friction: GPU, model download, phone over LAN |

## Goals
- G-1: Publish a strong challenge entry (post, 60–90 s video, public MIT repo) by **Sat 24 Oct 2026 23:00 Madrid**, aimed at Overall and Best Use of Gemma.
- G-2: **Gemma is the protagonist.** Gemma 4 E4B makes every judgement (listener, inspector, bookmaker, safety guard, judge, laundry planner) using text, image, audio, function calling and schema-validated JSON, and the UI shows its reasoning ("What Gemma saw", "Gemma's read"). Code only executes.
- G-3: A working phone-first core loop: capture → odds → bet / do it → settle with evidence → payout receipt → savings.
- G-4: **Honest, measured results**: Gemma (base and fine-tuned) vs the rule baseline vs a fixed routine, calibration with N shown everywhere, the photo's effect as an ablation, savings with stated assumptions, and losses reported.
- G-5: **Private by design**: photos, voice and habits never leave the laptop; the only outbound call is the weather API.

## Success metrics
| Metric | Target | How it is measured |
|---|---|---|
| Entry published | Post live by Sat 24 Oct 23:00 Madrid; repo public, MIT, tags `devchallenge` + `hf26challenge` | DEV post URL, repo settings |
| Live bets | ≥ 8 settled by Sat 24 Oct 18:00 Madrid; ≥ 3 settled by after photo; ≥ 2 chore types; every loss kept and reported. Known limit: settlement (T-009) and photos (T-007) merge Fri PM, so Thursday's bets settle by tap on Fri PM, and photo settlements come mostly from bets due Fri evening and Sat morning | Count from the app database |
| Bookmaker latency | ≤ 15 s per photo + forecast judgement on the builder's laptop | Measured in T-001 spike, re-measured on the live build |
| Structured-output reliability | ≥ 19 of 20 valid schema-conforming JSON answers per Gemma job | Spike run of 20 tries; schema validation failures logged |
| Backtest | Gemma vs rule vs fixed routine on Gràcia, Apr–Oct 2026, deciding only on forecasts from model runs started before the decision (day-1 lead), headline on the Sep–Oct hold-out; skips, chores avoided, savings and plant-risk days reported | Backtest report |
| Fine-tune | Base vs fine-tuned E4B bookmaker on the Sep–Oct 2026 hold-out: band calibration with N per band and Brier score [ASSUMPTION A-7]; result reported whether or not it improves | Evaluation report |
| Photo value | Same bets with and without the photo; difference in band vs outcome reported | Ablation report |
| Judge agreement | Share of Gemma verdicts the user overruled (on appeal), with N | App database |
| Savings honesty | Every savings number shows its assumption; net time subtracts ~30 s app time per bet; only won bets count | Review of the Score screen and post |
| Privacy | 0 outbound requests other than Open-Meteo during a full capture → settle cycle | Network check during the live week |

## Scope
Nothing from the concept is cut; scope is **ordered**. Each tier leaves a working app. Anything unfinished at the feature freeze (Sat 24 Oct 14:00 Madrid) stays behind a feature flag, off by default, and goes in the post as "next".

### In scope (this version), in build order
1. **Spikes**: Gemma 4 E4B photo + forecast → JSON timing and validity; phone photo upload over plain HTTP from WSL2; Historical Forecast API variables for Gràcia; QLoRA smoke run (10 steps fits in VRAM; merged model converts to GGUF). Each with a recorded fallback.
2. **Core loop**: typed capture → one card per chore (non-weather chores flagged); Gemma bookmaker (Open-Meteo via function calling, photo, habits → one of five odds bands, reason, settle time) with the rule baseline alongside; photo inspector; bet / "I'll do it" / undo; Slips with countdown; settle by tap or after photo with the Gemma judge; points and PAID OUT receipt; savings totals (net time, water, kWh).
3. Safety guard "Do it now" alerts (with fixed heat/frost/storm backstop); "Leave it out tonight" laundry bet; PAID OUT stamp animation.
4. Backtest (Gemma vs rule vs fixed routine; E2B vs E4B); bookmaker fine-tune (QLoRA on E4B, public weather data only) and its evaluation; Score screen with band calibration (N per band) and judge overrule rate.
5. Laundry planner (Wash today / Skip today / No good day); rescue alerts with cash-out; appeals (one per bet); onboarding with habit baseline; ranks and achievements; heater bet; split-flap weather board.
6. Voice capture through Gemma 4 audio (llama.cpp); whisper.cpp only as a fallback, stated in the post.

Chores in this version: balcony plants, laundry (leave it out tonight; wash today / skip today / no good day), skip the AC, skip the heater. The rest of the catalogue is shown as "coming later" or hidden.

### Non-goals (explicitly out of scope)
- Accounts, login, multi-household or multi-user use.
- Cloud hosting or any cloud backend; push notifications.
- Real money, stakes or anything resembling gambling with value: points only.
- Native apps; desktop layout (Figma desktop frames are reference only).
- Catalogue chores beyond the list above (car, bike, solar panels, snow, mowing, weeding, terrace rinsing, rain barrel).
- Spanish/Catalan capture and the backtest heating arena [ASSUMPTION A-5].
- Bets on safety: heatwave, frost, storms and vulnerable people are always alerts, never bets.

## Constraints
- Deployment target: **Local / on-device**. One Windows laptop (WSL2, NVIDIA GPU, 8 GB+ VRAM) runs Gemma, the app server, storage and the scheduler; the phone uses the web app over home Wi-Fi. The only outbound call at runtime is Open-Meteo. Fine-tuning runs on the same laptop (Colab as a fallback, public weather data only).
- Deadline: publish by **Sat 24 Oct 2026 23:00 Madrid** (official deadline Mon 26 Oct 07:59 Madrid). Feature freeze Sat 24 Oct 14:00 Madrid.
- Builder availability: Thu 22 Oct afternoon, Fri 23 Oct afternoon, Sat 24 Oct all day (~20 h, ~15 h of build); not Sunday. Thu and Fri mornings: agents build against a fake Gemma with recorded JSON fixtures; real-model work happens only in the builder's slots.
- Schedule checkpoints: Wed 21 night model pulled and spec approved · Thu afternoon spikes, real Gemma wired in, phone test, first real bets · Thu night fine-tune dataset built, training overnight · Fri afternoon fine-tune evaluated, photo settlements, agent PRs reviewed and merged · Sat 14:00 freeze, then video and post.
- Mandated technology: Gemma 4 (E4B primary, E2B for comparison) served locally (Ollama and/or llama.cpp); TypeScript (strict, Node.js LTS) for the app; Python only for the fine-tune (`training/`, uv, Unsloth or TRL + PEFT), recorded in an ADR.
- Licences: repo MIT; Gemma 4 Apache 2.0; Open-Meteo free tier is non-commercial only and its data is CC BY 4.0 (attribution required in the app and post); fonts SIL OFL; icons Lucide (ISC).
- Challenge rules: repo created inside the window (`adricasi/ShouldIBother`, 20 Oct), made public before submitting; any later commit noted in the README.
- Budget: ~0 € running cost; no paid APIs.
- Location: one household, neighbourhood-level coordinates for Gràcia, Barcelona.

## Glossary
| Term | Meaning |
|---|---|
| Chore card | One weather chore parsed from the user's input; may become a bet, an advice card, an alert or "not a weather chore" |
| Bet (do-nothing bet) | The user's commitment that doing nothing will be fine until the settle time |
| Odds band | One of five Gemma verdicts that doing nothing works: very likely · likely · toss-up · unlikely · very unlikely; code maps each to fixed odds |
| Odds | The fixed percentage for a band, locked at bet time; payout on a win is (100 − odds) × evidence multiplier |
| Rule baseline | Deterministic odds from forecast numbers (rain mm and probability, drying index, night temperature); stored on every bet and used as a comparison |
| Fixed routine | The habit baseline (e.g. water every other day, tumble dry every load, AC every warm evening) used in the backtest |
| Slip | A bet as shown in the UI (receipt style) |
| Settle time | When a bet is resolved, set by Gemma per chore |
| Settlement | Resolving a bet from recorded weather plus evidence, with a Gemma verdict |
| Evidence multiplier | ×1.0 for an after photo, ×0.5 for a one-tap answer or an auto-settled bet |
| Auto-settle | Settlement from the weather record at ×0.5 when the user does not answer within 24 h |
| Lucky win | A win where the weather did not deliver (e.g. no rain) but doing nothing still worked; does not count toward Gemma's accuracy |
| Safety alert | A "Do it now" card for heat, frost, storm or vulnerable-person cases; never a bet |
| Rescue alert / cash-out | A warning that the forecast turned against an open bet; cashing out (doing the chore now) costs 10 points |
| Net time back | Minutes saved by skipped steps on won bets, minus ~30 s app time per bet |
| Hold-out | Sep–Oct 2026 data kept out of fine-tune training for evaluation |

## Open questions
- [ ] Q-2: Runtime: Ollama primary, llama.cpp for audio (ADR-0004, 2026-10-21); quantization and digests still to be recorded by the T-001 spike.
- [ ] Q-5: Weather thresholds for the rule baseline and safety backstop per chore (rain mm for "watered", drying index weighting wind over temperature, night temperature for "skip the AC", heat/frost/storm limits).
- [x] Q-6: How settle times reach the phone: polling while the app is open, no notifications (answered 2026-10-21, see AC-007.2).
- [ ] Q-9: Confirm on the Week 3 rules page that the repo must be created in the 19–25 Oct window and whether a licence is required.
- [x] Q-10: Band-to-odds mapping: 85 / 70 / 50 / 35 / 15 (answered 2026-10-21).
- [ ] Q-11: Where the fine-tuned adapter is published (Hugging Face account and repo name) and its licence/model card wording.

## Assumptions
- A-1: Gemma 4 E4B returns a photo + forecast judgement in ≤ 15 s with ≥ 19/20 valid JSON on the laptop (unmeasured until T-001; fallback: text-only odds).
- A-2: The phone can upload a photo with `<input type="file" capture>` over plain HTTP once WSL mirrored networking (or a netsh portproxy) and a Windows firewall rule are set (unmeasured; fallback: Tailscale Serve).
- A-3: Open-Meteo's Previous Runs API (day-1 lead) has precipitation, humidity, wind, temperature and sunshine for Gràcia, Apr–Oct 2026 (unmeasured; fallbacks: Historical Forecast labelled "short-lead forecast (optimistic)", then a perfect-forecast upper bound).
- A-4: A 10-step QLoRA run on E4B fits in VRAM and the merged model converts to GGUF and loads in the local runtime (unmeasured; fallback: Colab).
- A-5: Spanish/Catalan capture and the backtest heating arena are out of this version (not in the build order).
- A-6: Until onboarding (tier 5) is built, the savings baseline is the builder's own habits, hardcoded in config.
- A-7: Calibration is summarised with band calibration (N per band) plus Brier score.
- A-8: One household and one fixed location; no per-user data separation.
