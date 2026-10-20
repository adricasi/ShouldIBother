# Idea brief: Should I Bother? — The Lazy Bookie

- Status: Validating <!-- Exploring | Validating | Go | Pivot | Parked | Killed -->
- Last updated: 2026-10-20
- One-liner: For people with a balcony, garden or washing line who do weather chores out of habit, Should I Bother? is a local AI bookmaker that turns each chore into a bet on doing nothing. Unlike a weather app, it judges *this* plant, *this* load and *this* evening from a photo plus the forecast, and settles every bet on evidence.
- Context: entry for the DEV Hacktoberfest Open-Source AI Challenge, Week 3 "Slow and Steady" (build something with open-source AI that rewards laziness). Deadline Sun 25 Oct 2026 23:59 PDT = Mon 26 Oct 07:59 Madrid. Judged mostly on writing quality; prizes: Overall and Best Use of Gemma.
- Companion files: `product-concept.md` (full product rules: catalogue, points, settlement, savings), `design-handoff.md` (Figma screens, components, tokens), `research-notes.md` (sources).

## 1. Problem
Many weather chores are done out of habit, not need: watering pots the evening before a storm, running the tumble dryer on a sunny, breezy day, switching the AC on when a night breeze would cool the flat. The weather would have done the job, but nobody checks, because checking takes judgement: a forecast says "20% rain", not "this basil can wait until Thursday".

- Who: households with outdoor space (balcony pots, small garden, washing line), starting with one flat in Gràcia, Barcelona.
- How often: several times a week (watering every 1–2 days in warm months, 2–4 laundry loads a week, AC or heating most evenings in season).
- Pain: small but constant — minutes of effort, litres of water and kWh of electricity spent when doing nothing would have worked. Over-watering and dryer use are the biggest waste.
- Today's workaround: habit, a glance at a weather app, or a fixed routine ("water every other day"); smart sprinkler controllers for people with irrigation systems.

## 2. Users and customers
| Segment | Job to be done | Current alternative | Willingness to pay |
|---|---|---|---|
| Flat with balcony pots and a washing line (first segment; the builder) | "Tell me when I can skip watering or the dryer, and prove it was right" | Weather app + habit | None needed: free, open source |
| Small-garden owners without smart irrigation | Skip watering and mowing when the weather covers it | Fixed routine, weather app | Low (an app, not hardware) |
| Hackathon judges and DEV readers | A fun, honest demo of Gemma doing real judgement locally | — | — |

## 3. Solution concept
- **Capture**: type, say or photograph chores ("wash the car, do the laundry, water the plants"); Gemma splits them into one card per chore and flags non-weather chores.
- **Odds**: Gemma combines the forecast, an optional photo and the user's habits into odds that doing nothing works, a one-line reason, a settle time, a payout and a penalty, plus the time, water and electricity at stake.
- **Bet or do it**: "Bet: do nothing" or "I'll do it"; odds lock at bet time; undo always available.
- **Settle on evidence**: recorded weather plus an after photo (×1.0) or one tap (×0.5); Gemma judges with its evidence; unanswered bets auto-settle at ×0.5 after 24 h.
- **Lazy Payoff**: points and ranks for correct laziness, real savings totals (net time, water, electricity), and Gemma's own calibration scoreboard.
- **Safety first**: heatwaves, frost, storms and vulnerable people are "Do it now" alerts, never bets.

Core loop: capture → odds → bet → wait (rescue alert / cash-out) → settle with evidence → payout receipt → savings totals.

Why it is clearly better for the first segment: a weather app gives a forecast; this gives a decision about a specific item, puts points on it, and checks afterwards whether it was right. Everything private (photos of the home, voice, habits) stays on the device.

## 4. Market and competition
Summary of `research-notes.md`. No direct competitor found that combines photo + forecast judgement, betting on inaction, and evidence-based settlement. Adjacent products cover one slice each.

| Competitor / alternative | Strengths | Weaknesses | Pricing |
|---|---|---|---|
| Do nothing / habit / weather app | Free, zero effort | No judgement about the specific item; no feedback loop; waste goes unnoticed | Free |
| Laundry Timer – Drying Times (iOS) | Outdoor drying-time estimates from temperature, sun, humidity, wind; 3-day drying forecast; rain alerts | Laundry only; no photo; no savings or game | Free, Pro £2.99 |
| Rachio 3 smart sprinkler controller | Rain, freeze and wind skip for irrigation; strong accuracy reviews | Needs an irrigation system and hardware; no balcony pots, laundry or AC | ~$250 (8-zone) hardware |
| Greg (plant care app) | Plant ID, watering schedules, care recommendations that adapt to local weather | Subscription; schedule-based, not "skip today" bets; no settlement | $29.99/year |
| Habitica (gamified tasks) | Proven points/rewards loop for chores | Rewards *doing* tasks, the opposite of the idea; no weather or AI | Free tier; premium $5/month |
| Plant and Log: Water Guide (iOS) | Watering reminders that skip outdoor plants on likely-rain days; streaks | Watering only; no photo judgement or settlement | Free + in-app purchases |
| Home Assistant Smart Irrigation (open source) | Soil-moisture bucket from rain and evapotranspiration, forecast-aware | Sprinkler valves only, needs Home Assistant; not hand-watered pots | Free |

Gap: nobody rewards correct inaction, and nobody settles chore decisions against recorded weather and photos. Skip-on-rain for watering alone is no longer novel (Plant and Log), so the post must lead with the bet-and-settle loop and the photo judgement, not "it tells you when it rains".

Competition inside the challenge (revisit 2026-10-20): the `hf26challenge` tag is crowded with "sloth" tools (CommitSloth, SlothPlan, Sloth Fridge: a local vision model that plans dinner from one photo, and others). None found on weather, laundry or watering. Local Gemma alone won't stand out; the evidence-settled bet and honest numbers have to.

## 5. Business model
- Revenue model: none — open source (MIT) hackathon project and portfolio piece. Value is measured as time, water and electricity saved.
- Pricing hypothesis: n/a. Note: Open-Meteo's free tier is for non-commercial use only; a commercial version would need a paid API plan.
- Rough unit economics (estimate): running cost ≈ 0 € (local model, free non-commercial weather API, user's own laptop and electricity).
- Go-to-market: the DEV post ("I let a local AI be my bookmaker for a week"), the public repo and a 60–90 s demo video. First users: the builder's household for the live week, then DEV readers who run it locally.

## 6. Technical feasibility
- Deployment target: **Local / on-device** (no cloud). The only network call is the weather API.
- Architecture sketch (local): one laptop runs Gemma 4 (via Ollama or llama.cpp, localhost only), a small app server, SQLite and a scheduler; the phone opens a mobile web app over home Wi-Fi; Open-Meteo provides the forecast and recorded (archive) weather.
- Key technologies: Gemma 4 E4B (text + image, audio on E2B/E4B per Google; structured JSON output and function calling), Open-Meteo forecast + archive + **Historical Forecast** APIs, SQLite, a phone-first web UI built from the Figma design. Stack still open (TypeScript suggested).
- Hardware (revisit): a laptop with an NVIDIA GPU, 8 GB+ VRAM. Published E4B numbers on an 8 GB RTX 3050 are about 60 tok/s generation and ~2,200 tok/s prompt processing (one blog post); no image-prefill timings found. Estimate: a few seconds per photo judgement at a 140–280 image-token budget. Measure on day 1 and put the real number in the post.
- Hard parts / unknowns (updated after research):
  1. **Audio**: Ollama lists audio for `gemma4:e4b`, but it works reliably only on the Apple Silicon MLX engine; on NVIDIA, open issues report audio routed as an image and intermittent crashes; llama.cpp calls Gemma 4 audio "highly experimental". Chrome's Web Speech API sends audio to Google, which breaks the "stays on device" claim. → **Cut voice from the MVP** (typed capture only); revisit only if everything else is done.
  2. **Small-model judgement quality**: a 4B model will not produce calibrated probabilities on its own. → **The odds come from a rule baseline** (rain mm and probability, drying index, night temperature); Gemma adds a bounded photo adjustment (±20 points, clamped), the one-line reason and the "unsure, ask the user" path. Calibration is reported for the rule, and Gemma's value as an ablation (odds with vs without the photo).
  3. **Phone access over LAN**: `getUserMedia`, mic recording, notifications and service workers need HTTPS, but a plain `<input type="file" accept="image/*" capture="environment">` is a file picker with no secure-context requirement in the spec (still to confirm on your phone). → Photos over plain HTTP first; Tailscale Serve (`https://*.ts.net`, private to your tailnet) only if needed. Avoid a Cloudflare quick tunnel: it is public and routes home photos through Cloudflare.
  4. **Backtest without lookahead** (new): feeding Gemma recorded weather as "the forecast" leaks the outcome. Open-Meteo's Historical Forecast API archives past forecasts (ICON since Nov 2022, GFS since 2021) and the Previous Runs API gives values as forecast 1–7 days earlier (since Jan 2024). → Decide on the archived forecast, settle on recorded weather; one test call for Gràcia confirms which variables exist. The stitched series is short-lead, so say it flatters accuracy slightly.
- Data, privacy and compliance: photos of the home, voice notes and habits stay on the laptop; EXIF/location stripped from photos; only coarse location (neighbourhood coordinates) goes to the weather API. No accounts, no payments, no real-money betting (points only, no stakes), no personal data leaves the device. Safety cases are alerts, never bets.
- Build effort for an MVP (estimate): 6 days solo (Tue 20 – Sun 25 Oct), assisted by the AI toolkit; see the build plan in `product-concept.md`.
- Running cost (estimate, monthly): ~0 € at 1 / 10 users (each user runs their own copy). 1,000+ users would be 1,000 local installs; the shared cost is weather API calls, free within Open-Meteo's non-commercial limits (<10,000 calls/day per IP).

## 7. Personal fit
Builder: experienced with AI-assisted, spec-driven development (own AI toolkit), cloud and full-stack work. Learns: running and evaluating an open-weight multimodal model locally, calibration evals, phone-first UI. Portfolio value: a public, well-documented Gemma project with real measured results. Time: six evenings/days this week; a live test runs in the builder's own home in Barcelona.

## 8. Risks and pre-mortem
"It's 26 October and the entry did badly. Why?"

| Risk | Likelihood | Impact | Mitigation / test |
|---|---|---|---|
| Dry week in Barcelona: few rain bets win | High | Medium | Lean on sun, wind and temperature chores (laundry, AC, heater); the 6-month backtest covers rain; report "Gemma told me to water anyway" honestly |
| Looks like a weather app with points | Medium | High | Show the photo + forecast judgement and the evidence-based settlement in the demo and post |
| Inflated savings numbers | Medium | High | Count skipped steps only; subtract ~30 s app time per bet; use the user's own baseline; cite water and energy sources |
| Small-model mistakes (plant type, dampness) | Medium | Medium | JSON schema + "unsure" path; one appeal per bet; report errors and calibration in the post |
| Gemma audio not available in the chosen runtime | Medium | Low | Day-1 spike; typed capture always works; voice is first to cut |
| Phone camera blocked on plain HTTP over LAN | High | High | Local HTTPS certificate or tunnel, tested on day 1 |
| Scope too wide for six days | High | High | MVP limited to plants, laundry, AC, heater; strict cut list |
| Laptop too slow for photo judging | Low–Medium | Medium | E4B; resize photos; batch the backtest overnight; confirm RAM/GPU |
| Gaming the points | Low | Low | Live, timestamped in-app photos; auto-settle after 24 h; tap-only wins pay half |
| Repo or post rules missed (public repo, licence, created in window) | Low | High | Use `adricasi/ShouldIBother` (created 20 Oct, inside the 19–25 Oct window), MIT, switch it to public before submitting; tags `devchallenge` + `hf26challenge`; re-read the Week 3 rules page (only the Week 1 rules text was found) |
| Backtest leaks the outcome (Gemma sees recorded weather as "forecast") | High if unchanged | High | Decide on the Historical Forecast API, settle on the archive; label any perfect-forecast run as an upper bound |
| Post written in a rush on Sunday (writing is weighted most) | High | High | Draft from Fri with placeholders; numbers and video Sat; edit Sun morning; publish by 22:00 Madrid Sun, not at the 07:59 Mon deadline |
| Too few settled bets for a calibration chart | High | Medium | Show N in every band; lead with counts and the failure story, not points or percentages |
| Savings read as self-graded (catalogue constant × wins, tap-only outcomes) | Medium | Medium | Say so up front in the post: assumptions table, ×0.5 for tap-only, auto-settle after 24 h |

## 9. Scorecard
Revisited 2026-10-20 after research and the devil's-advocate pass (draft was 56).

| Criterion | Weight | Score (1–5) | Why |
|---|---|---|---|
| Problem severity & frequency | 3 | 3 | Frequent but low-stakes waste; the theme fit carries more than the problem |
| Reachable users / market | 2 | 3 | For this goal the audience is judges and DEV readers, who read the post rather than install it; local Gemma + LAN setup keeps real installs low |
| Differentiation | 2 | 4 (was 5) | Skip-on-rain watering exists (Plant and Log); the bet-and-settle loop and photo judgement are still unclaimed, inside and outside the challenge |
| Technical feasibility (for me) | 2 | 4 | NVIDIA GPU fits E4B; each unknown now has a known fallback (typed capture, file input over HTTP, Historical Forecast API) |
| Time & cost to MVP | 2 | 2 (was 3) | Even trimmed, build + live week + backtest + video + post in six days; zero running cost |
| Business viability | 2 | 2 | Not a business; irrelevant to the goal |
| Personal fit & learning | 2 | 5 | Local multimodal model, evals, measured results, spec-driven build |
| Risk (5 = low) | 1 | 2 (was 3) | Several High/High risks (scope, rushed post, backtest leakage), each with a mitigation |
| **Weighted total (max 80)** | | **52** | 9 + 6 + 8 + 8 + 4 + 4 + 10 + 2 |

## 10. Verdict and next steps
- Verdict (revisited 2026-10-20): **Go, with a cut scope** — still distinctive, on-theme and measurable, but the original plan is a three-week product in six days. Go holds only if the core loop runs from the phone by Wed night and the post gets real writing time.
- MVP scope (revisited; the post needs one clear story, not six Gemma jobs):
  - In: typed capture → cards (listener); rule-baseline odds with Gemma's bounded photo adjustment and one-line reason (inspector/forecaster); safety guard → "Do it now" alerts; bet / "I'll do it" / undo; Slips with countdown; settlement with after photo or one tap and Gemma verdict (judge); points and the PAID OUT receipt; savings totals (net time, water, kWh); "Leave it out tonight" for laundry; Score screen with counts and a calibration chart that shows N per band; backtest script on the Historical Forecast API.
  - Chores in the MVP: balcony plants, laundry, skip the AC (heater only if the week turns cold).
  - Styling: design tokens, the paper receipt slip and the one stamp animation; use the Figma screens as post images rather than building every screen.
  - Moved out (were in): voice capture (audio unreliable on NVIDIA; Web Speech is cloud), rescue alerts and cash-out (show as concept), appeals, ranks and achievements beyond the rank name, onboarding questions (hardcode your own baseline), the full laundry planner, split-flap animation, Spanish/Catalan capture, the backtest heating arena.
  - Explicitly out: accounts, cloud hosting, push notifications, real money, multi-household, desktop layout, native apps, car/bike/solar/snow/mowing chores (catalogue only).
  - Never cut: photo settlement and the savings numbers with their assumptions.
- Schedule checkpoints: Tue night spikes done (model + photo JSON, phone photo upload, Historical Forecast call) · Wed night first real bet placed from the phone · Thu night first bet settled with a photo, then freeze features · Fri backtest table + post draft with placeholders · Sat numbers, screenshots, 60–90 s video · Sun edit, publish by 22:00 Madrid.
- Validation experiments before building (cheapest first):
  | Hypothesis | Experiment | Success signal | Cost/time |
  |---|---|---|---|
  | Gemma 4 E4B runs locally fast enough with image input and JSON output | Runtime spike: Ollama vs llama.cpp, one photo + forecast → JSON | < 15 s per judgement on the laptop; valid JSON ≥ 95% on 20 tries | 2 h |
  | The phone can take and upload a photo over plain HTTP on the LAN | File-input spike: `<input type="file" accept="image/*" capture="environment">` at `http://<laptop-ip>:<port>` on your phone | Photo reaches the server; Tailscale Serve only if it doesn't | 30 min |
  | The backtest can decide on past forecasts, not outcomes | One Historical Forecast API call for Gràcia, Apr–Oct 2026, hourly precipitation, humidity, wind, temperature, sunshine | All needed variables present for at least one model | 15 min |
  | Rule odds beat the fixed routine, and the photo adds something | Backtest on 6 months (decide on archived forecasts, settle on recorded weather) + photo ablation on a small fixed photo set | More skips than "water every other day" with no extra plant-risk days; odds with photo closer to the outcome than without | 1 day incl. overnight run |
  | Enough real bets for a story | Count the weather chores you actually do this week | ≥ 12 settled bets by Sat | 5 min |
- Kill / pivot criteria: model + photo + JSON over ~30 s, or no phone photo upload, by Tue night → text-only odds and say so in the post · no real bet placed from the phone by Wed night → rule-only odds with Gemma reasons, drop the backtest · no backtest table by Fri night → ship it as a labelled perfect-forecast upper bound or drop it, don't spend Sat on it · the backtest shows no gain over "water every other day" → make honest calibration the story, not savings.

## Open questions
- [ ] Q-1: Stack: TypeScript end to end (suggested) or Python backend?
- [ ] Q-2: Runtime: Ollama or llama.cpp, after the spike; which quantization? (Audio no longer decides it.)
- [x] Q-3: Laptop hardware: NVIDIA GPU, 8 GB+ VRAM (answered 2026-10-20).
- [ ] Q-4: Odds: rule baseline + bounded Gemma photo adjustment (proposed in the revisit, see §6) — confirm in `/spec`.
- [ ] Q-5: Weather thresholds per chore (rain mm for "watered", drying index for laundry, night temperature for "skip the AC"). Note: wind matters more than temperature for drying (Met Office, see research notes).
- [ ] Q-6: How settle times reach the phone: proposed polling while the tab is open, no notifications in the MVP (they need HTTPS).
- [x] Q-7: Repo: the existing `adricasi/ShouldIBother` (created 20 Oct), made public before submitting (answered 2026-10-20).
- [ ] Q-8: Desktop layout in scope? (Proposed: out; Figma desktop frames are reference only.)
- [ ] Q-9: Confirm on the Week 3 rules page that the repo must be created in the 19–25 Oct window and whether a licence is required (only the Week 1 rules text was found).

## Sources
See `research-notes.md`.
