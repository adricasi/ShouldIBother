# Requirements: Should I Bother?

- Status: Approved (2026-10-21) <!-- Draft | In review | Approved -->
- Last updated: 2026-10-21

IDs are permanent: never renumber or reuse. Deprecate with ~~strikethrough~~ and a note.
Acceptance criteria use EARS style: `WHEN <trigger> [WHILE <state>] THE SYSTEM SHALL <response>`
(or `IF <unwanted condition> THEN THE SYSTEM SHALL <response>`). Each one must be testable.

Priority follows the build order in [product.md](product.md#scope): **Must** = tiers 1–2 (core loop) plus safety, security and privacy; **Should** = tiers 3–4; **Could** = tiers 5–6. Nothing is cut: unfinished items at the feature freeze ship behind a flag, off by default (REQ-029).

Fixed values used below:
- **Odds bands → odds**: very likely 85 · likely 70 · toss-up 50 · unlikely 35 · very unlikely 15 (%, chance that doing nothing works).
- **Payout on a do-nothing win**: (100 − odds) × evidence multiplier, rounded to the nearest integer (halves up). Multiplier: after photo ×1.0, one tap ×0.5, auto-settle ×0.5.
- **Other outcomes**: small loss −25 · normal loss −50 · harmful loss −150 · cash-out −10 · "I'll do it" and the weather would not have helped +5 · "I'll do it" and the weather would have done it −10 · advice followed +5.
- **Gemma timeouts**: 30 s per model call; 45 s deadline per Gemma job end to end (all calls, tool calls and the retry; for a photo, inspector + bookmaker together).

## Functional requirements

### REQ-001: Pair a device
- Story: As the household owner, I want only my own phone and laptop to open the app, so that nobody else on the Wi-Fi sees photos of my home or places bets.
- Priority: Must
- Goals: G-5
- Acceptance criteria:
  - AC-001.1: WHEN the server starts or the user runs `sib pair` THE SYSTEM SHALL generate a new pairing token of at least 128 bits from a cryptographically secure random source, valid for 10 minutes, print a pairing URL and QR code to the laptop console, and leave existing sessions valid.
  - AC-001.2: WHEN a device opens the pairing URL with a valid, unexpired token THE SYSTEM SHALL set an HttpOnly, SameSite=Strict session cookie and redirect to a URL that does not contain the token; one token may pair several devices within its 10 minutes.
  - AC-001.3: IF a request to any route other than `/pair` (pages, API, photo files) lacks a valid session THEN THE SYSTEM SHALL respond 401 and return no app data.
  - AC-001.4: IF a POST, PUT or DELETE request carries an Origin header that does not match the app's own origin, or no Origin header THEN THE SYSTEM SHALL reject it with 403.
  - AC-001.5: IF more than 10 failed pairing or session attempts arrive from one client address within 1 minute THEN THE SYSTEM SHALL reject further attempts from that address for 1 minute.
  - AC-001.6: WHEN the user runs "Forget devices" (in the app or `sib forget-devices`) THE SYSTEM SHALL invalidate all existing sessions and any unexpired pairing token.
  - AC-001.7: THE SYSTEM SHALL never write the pairing token or session identifiers to logs.
  - AC-001.8: IF a session is older than 30 days or a pairing token is older than 10 minutes THEN THE SYSTEM SHALL treat it as invalid.

### REQ-002: Capture chores as cards
- Story: As a household member, I want to type my chores in one sentence, so that each one becomes its own card without filling in forms.
- Priority: Must
- Goals: G-2, G-3
- Acceptance criteria:
  - AC-002.1: WHEN the user submits a typed sentence THE SYSTEM SHALL send it to the Gemma listener and show one card per chore found.
  - AC-002.2: WHEN the listener classifies a chore as having no weather link THE SYSTEM SHALL show it as "Not a weather chore" with no odds and no bet action.
  - AC-002.3: WHEN the listener maps a chore to one outside this version's chore list THE SYSTEM SHALL show it as "Coming later" with no bet action.
  - AC-002.4: IF the listener's answer fails schema validation after one retry THEN THE SYSTEM SHALL keep the user's text and show "Gemma couldn't read that, try rephrasing" without creating cards.
  - AC-002.5: WHEN the user taps a quick chip (e.g. "Water plants") THE SYSTEM SHALL create the matching card without calling the listener.

### REQ-003: Gemma sets the odds
- Story: As a household member, I want Gemma to tell me how likely doing nothing is to work, with a reason, so that I can decide in seconds.
- Priority: Must
- Goals: G-2, G-3
- Acceptance criteria:
  - AC-003.1: WHEN a weather chore card is created THE SYSTEM SHALL ask the Gemma bookmaker for an odds band, a one-line reason and a settle time, with the forecast obtained through a weather tool call made by Gemma (function calling).
  - AC-003.2: WHEN the bookmaker returns a schema-valid answer THE SYSTEM SHALL show the band name, the mapped odds, the reason, the settle time, the payout for each outcome and the time, water and electricity at stake, labelled "Gemma's odds".
  - AC-003.3: WHEN the bookmaker answers "unsure" with a yes/no question THE SYSTEM SHALL show the question inside the card as two tap answers and re-ask the bookmaker with the answer.
  - AC-003.4: IF the bookmaker's answer fails schema validation after one retry THEN THE SYSTEM SHALL keep the rule odds on the card (REQ-013) and log the failure.
  - AC-003.5: THE SYSTEM SHALL show plain words next to every odds percentage (e.g. "Likely · 70%").
  - AC-003.6: IF the bookmaker answers without calling the `get_forecast` tool THEN THE SYSTEM SHALL retry once and, if the tool is still not called, keep the labelled rule odds (REQ-013) and record the miss for the tool-call miss rate.

### REQ-004: Rule baseline alongside Gemma
- Story: As the builder, I want a deterministic rule model scored on every bet, so that Gemma has an honest baseline to beat.
- Priority: Must
- Goals: G-4
- Acceptance criteria:
  - AC-004.1: WHEN a weather chore card is created THE SYSTEM SHALL compute a rule-baseline band from the forecast (rain amount and probability, drying index weighting wind over temperature, night temperature) without calling Gemma, within 1 s when a forecast younger than 1 h is cached, otherwise within 1 s of the forecast fetch completing (fetch timeout 5 s).
  - AC-004.2: WHEN a bet is placed THE SYSTEM SHALL store both the Gemma band (if any) and the rule band on the bet.
  - AC-004.3: IF Gemma's band is two or more bands away from the rule band THEN THE SYSTEM SHALL accept the bookmaker's answer only if it contains a non-empty disagreement explanation or a yes/no question for the user; otherwise it SHALL treat the answer as invalid (AC-003.4).

### REQ-005: Photo makes the odds sharper
- Story: As a household member, I want to add a photo of the plant or laundry, so that the odds reflect this specific item.
- Priority: Must
- Goals: G-2, G-5
- Acceptance criteria:
  - AC-005.1: WHEN the user adds a photo to a card THE SYSTEM SHALL strip all EXIF and location metadata and resize it to at most 1024 px on the longest side before storing it or sending it to Gemma.
  - AC-005.2: WHEN a photo is stored THE SYSTEM SHALL ask the Gemma inspector for its observations (item type, soil dryness or dampness, wilting, cover from rain) and re-run the bookmaker with them.
  - AC-005.3: WHEN the bookmaker returns odds after a photo THE SYSTEM SHALL show a "What Gemma saw" list and the odds before → after (e.g. "35% → 50%").
  - AC-005.4: IF the inspector answers "unsure" (e.g. too dark) THEN THE SYSTEM SHALL keep the odds without the photo and show Gemma's yes/no question.
  - AC-005.5: WHEN a bet is placed with a photo THE SYSTEM SHALL store the odds band with and without the photo, for the photo ablation.
  - AC-005.6: IF an uploaded file is not an image format the system can decode (e.g. HEIC without decoder support) THEN THE SYSTEM SHALL respond 415 with a message telling the user how to send a supported photo, and keep the card unchanged.

### REQ-006: Bet, do it, or undo
- Story: As a household member, I want to bet on doing nothing or say I'll do the chore, so that each decision is recorded and later scored.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-006.1: WHEN the user taps "Bet: do nothing" THE SYSTEM SHALL create a bet with the odds, band, odds source, reason and settle time shown at that moment, and lock them.
  - AC-006.2: WHEN the forecast or Gemma's answer changes after a bet is placed THE SYSTEM SHALL NOT change that bet's odds, band or payouts.
  - AC-006.3: WHEN the user taps "I'll do it" THE SYSTEM SHALL record a do-it decision with the same odds and settle time, to be scored at settlement (REQ-009).
  - AC-006.4: WHEN the user taps Undo within 5 minutes of placing a bet or do-it decision THE SYSTEM SHALL delete it with no points [ASSUMPTION A-9].
  - AC-006.5: IF the user tries to undo more than 5 minutes after placing THEN THE SYSTEM SHALL not offer Undo (cash-out, REQ-022, is the way out).

### REQ-007: Slips with countdown
- Story: As a household member, I want to see my open bets and when they settle, so that I know what is waiting and what to settle now.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-007.1: WHEN the user opens Slips THE SYSTEM SHALL list bets in three groups: Settle now, Waiting (with time left) and Settled (with result and points).
  - AC-007.2: WHEN Slips is loaded or refreshed THE SYSTEM SHALL list every bet whose settle time is at or before the current time under Settle now (computed at read time); WHILE Slips is open THE SYSTEM SHALL refresh at least every 30 s.
  - AC-007.3: WHEN a group is empty THE SYSTEM SHALL show an empty state that says what will appear there.

### REQ-008: Settle on evidence with the Gemma judge
- Story: As a household member, I want each bet settled from the recorded weather and my evidence, with Gemma's verdict explained, so that wins and losses are fair.
- Priority: Must
- Goals: G-2, G-3, G-4
- Acceptance criteria:
  - AC-008.1: WHEN a bet reaches its settle time THE SYSTEM SHALL fetch the recorded weather for the bet's window and show it on the settle screen.
  - AC-008.2: WHEN the user submits an after photo THE SYSTEM SHALL strip and resize it (AC-005.1) and send the before photo (if any), the after photo and the recorded weather to the Gemma judge.
  - AC-008.3: WHEN the user answers with one tap ("Yes, dry" / "Damp" / "Wet", or the chore's equivalent) THE SYSTEM SHALL send the answer and the recorded weather to the Gemma judge.
  - AC-008.4: WHEN the judge returns a verdict THE SYSTEM SHALL show it as win, small loss, normal loss or harmful loss with a one-line reason and its evidence ("Gemma's read"), apply the points (REQ-009) and mark the bet settled.
  - AC-008.5: WHEN the judge returns "unsure" THE SYSTEM SHALL ask the user its yes/no question and re-judge with the answer.
  - AC-008.6: WHEN the judge decides a win where the recorded weather did not deliver (e.g. no rain on a rain bet) THE SYSTEM SHALL mark it a lucky win, pay it as a win and count it separately from Gemma's calibration.
  - AC-008.7: IF a bet has no user answer 24 h after its settle time THEN THE SYSTEM SHALL have the judge settle it from the recorded weather alone, at the ×0.5 multiplier.
  - AC-008.8: IF Gemma is unavailable when a bet needs a verdict THEN THE SYSTEM SHALL keep the bet in "Settle when Gemma is back" and never settle it with the rule model; when Gemma returns it SHALL judge it (×0.5 if the 24 h limit passed).
  - AC-008.9: WHEN a do-it decision reaches its settle time THE SYSTEM SHALL have the judge decide from the recorded weather whether the weather would have done the chore.

### REQ-009: Points
- Story: As a household member, I want points that reward correct laziness and punish wrong laziness, so that skipping only pays when it is smart.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-009.1: WHEN a do-nothing bet is settled as a win THE SYSTEM SHALL add (100 − odds) × multiplier points, rounded to the nearest integer (halves up).
  - AC-009.2: WHEN a do-nothing bet is settled as a small, normal or harmful loss THE SYSTEM SHALL add −25, −50 or −150 points respectively, regardless of the evidence multiplier.
  - AC-009.3: WHEN a do-it decision is settled THE SYSTEM SHALL add +5 if the weather would not have done the chore and −10 if it would have.
  - AC-009.4: THE SYSTEM SHALL compute the points total from the stored settled outcomes, so the total equals the sum of each bet's points.

### REQ-010: PAID OUT receipt
- Story: As a household member, I want a payout receipt when I win, so that the win feels like one and shows what it saved.
- Priority: Must
- Goals: G-1, G-3
- Acceptance criteria:
  - AC-010.1: WHEN a do-nothing bet is settled as a win THE SYSTEM SHALL show a receipt with the bet, odds, evidence type, recorded weather, points won, time saved and water or electricity saved, with a "PAID OUT" stamp.
  - AC-010.2: WHEN a bet is settled as a loss THE SYSTEM SHALL show the result with its points and reason, without the PAID OUT stamp and without shaming copy.

### REQ-011: Savings totals
- Story: As a household member, I want to see the time, water and electricity the weather saved me, so that I know laziness was worth it.
- Priority: Must
- Goals: G-3, G-4
- Acceptance criteria:
  - AC-011.1: WHEN a do-nothing bet is settled as a win THE SYSTEM SHALL add the chore's catalogue savings (time, water, electricity), using the household baseline, to the totals.
  - AC-011.2: THE SYSTEM SHALL count no savings for losses, do-it decisions or undone bets.
  - AC-011.3: THE SYSTEM SHALL report net time back as time saved minus 30 s per bet or do-it decision placed and not undone, and show both parts (e.g. "2 h 10 saved, minus 6 min spent on 12 bets").
  - AC-011.4: THE SYSTEM SHALL count time only for skipped steps; electricity-only savings (e.g. line instead of dryer) add 0 minutes.
  - AC-011.5: THE SYSTEM SHALL show the assumption behind each savings figure where it is displayed (e.g. "vs a heat-pump dryer, ~2 kWh").
  - AC-011.6: WHEN the user opens Today THE SYSTEM SHALL show this week's totals (Monday–Sunday): net time back, water in litres and electricity in kWh.

### REQ-012: Safety is never a bet
- Story: As a household member, I want risky weather to tell me to act, so that the game never puts plants or people at risk.
- Priority: Must (fixed backstop, AC-012.1–012.2) · Should (Gemma safety guard, AC-012.3–012.4; tier 3)
- Goals: G-2, G-3
- Acceptance criteria:
  - AC-012.1: IF the forecast for a card's window crosses a fixed heat, frost or storm limit (values in design.md, Q-5) THEN THE SYSTEM SHALL show a "Do it now" alert with the reason and no bet action, whatever Gemma's answer.
  - AC-012.2: IF a request to place a bet arrives for a card in alert state THEN THE SYSTEM SHALL reject it.
  - AC-012.3: WHEN a card is created THE SYSTEM SHALL ask the Gemma safety guard whether the chore touches safety (heat, frost, storm, vulnerable people) and, if it says yes, show a "Do it now" alert with its reason and no bet action.
  - AC-012.4: IF the safety guard is unavailable THEN THE SYSTEM SHALL still apply the fixed backstop (AC-012.1).

### REQ-013: Rule odds while Gemma thinks or is offline
- Story: As a household member, I want odds at once even when Gemma is slow or down, so that the app never blocks me.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-013.1: WHEN a weather chore card is created THE SYSTEM SHALL show the rule band at once, labelled "Gemma is thinking · rule odds".
  - AC-013.2: WHEN Gemma's answer arrives before a bet is placed THE SYSTEM SHALL replace the rule band, reason and settle time with Gemma's and label the card "Gemma's odds".
  - AC-013.3: IF the Gemma job does not finish within its 45 s deadline or Gemma is not running THEN THE SYSTEM SHALL label the card "Gemma offline · rule odds", offer Retry, and still allow betting.
  - AC-013.4: WHEN a bet is placed on rule odds THE SYSTEM SHALL store odds_source = rule; such bets count for points, savings and the rule's calibration, and are excluded from Gemma's calibration and the base-vs-fine-tuned comparison.
  - AC-013.5: WHILE the app is open THE SYSTEM SHALL show Gemma's status (online / offline) on Today, refreshed at least every 60 s.

### REQ-014: Weather data
- Story: As a household member, I want the odds and settlements based on real forecasts and recorded weather for my neighbourhood, so that the bets are about my weather.
- Priority: Must
- Goals: G-3, G-4, G-5
- Acceptance criteria:
  - AC-014.1: WHEN the weather tool is called THE SYSTEM SHALL request the Open-Meteo forecast for the household's configured coordinates, rounded to 2 decimal places.
  - AC-014.2: WHEN a forecast is fetched THE SYSTEM SHALL cache it with its fetch time and reuse it for at most 1 h.
  - AC-014.3: IF Open-Meteo is unreachable THEN THE SYSTEM SHALL use the latest cached forecast and show its age (e.g. "Forecast from 3 h ago").
  - AC-014.4: IF no forecast younger than 24 h is available THEN THE SYSTEM SHALL show "No forecast, can't set odds" on new cards and not allow betting [ASSUMPTION A-10].
  - AC-014.5: IF recorded weather for a bet's window is not yet available THEN THE SYSTEM SHALL keep the bet waiting and retry at least every 30 min.
  - AC-014.6: THE SYSTEM SHALL show the Open-Meteo attribution (CC BY 4.0) in the app and the README.

### REQ-015: Own and delete my data
- Story: As a household member, I want to delete photos and bets and export my data, so that I control what is kept about my home.
- Priority: Must
- Goals: G-5, G-4
- Acceptance criteria:
  - AC-015.1: THE SYSTEM SHALL store the database and photos in a data folder outside the source tree that is listed in `.gitignore`.
  - AC-015.2: WHEN the user deletes a photo or a bet in the app THE SYSTEM SHALL remove the photo file(s) and records from disk (SQLite `secure_delete` on, WAL checkpointed so deleted rows are overwritten) and recompute totals.
  - AC-015.3: WHEN the user runs the delete-all command THE SYSTEM SHALL remove all photos, and with `--all-data` also the database, logs and weather cache, after a confirmation prompt.
  - AC-015.4: WHEN the user runs the export command THE SYSTEM SHALL write a JSON file of all bets, decisions, verdicts and totals plus the photo files to a chosen folder.

### REQ-016: Chores in this version
- Story: As a household member, I want bets for the chores I actually do this week, so that the live week produces real bets.
- Priority: Must (balcony plants, skip the AC) · Should (laundry: leave it out tonight) · Could (skip the heater)
- Goals: G-3
- Acceptance criteria:
  - AC-016.1: THE SYSTEM SHALL support do-nothing bets for "water balcony plants" and "skip the AC tonight", with catalogue savings and settle-time rules.
  - AC-016.2: WHEN the user creates a "Leave it out tonight" card between 1 h before and 2 h after sunset THE SYSTEM SHALL offer a "Leave it out tonight" bet (outside that window the card says when it can be offered) that wins if the laundry is dry in the morning and loses if dew or rain dampened it.
  - AC-016.3: THE SYSTEM SHALL support a "skip the heater" bet settled by a one-tap comfort answer.

### REQ-017: PAID OUT stamp animation
- Story: As a demo viewer, I want the PAID OUT stamp to land, so that the win moment is memorable.
- Priority: Should
- Goals: G-1
- Acceptance criteria:
  - AC-017.1: WHEN the win receipt opens THE SYSTEM SHALL animate the stamp from scale 1.6 to 1 with a −8° rotation over 220–280 ms.
  - AC-017.2: WHILE the device prefers reduced motion THE SYSTEM SHALL show the stamp with a fade only.

### REQ-018: Backtest
- Story: As the builder, I want to replay six months of Gràcia weather, so that the post can compare Gemma, the rule and a fixed routine beyond one dry week.
- Priority: Should
- Goals: G-4
- Acceptance criteria:
  - AC-018.1: WHEN the backtest runs THE SYSTEM SHALL decide each simulated day only from forecasts issued by model runs that started before the decision time (Open-Meteo Previous Runs API, day-1 lead), and settle it from recorded weather (archive).
  - AC-018.2: IF day-1-lead forecasts are not available for a variable THEN THE SYSTEM SHALL fall back to the Historical Forecast API and label the affected results "short-lead forecast (optimistic)", or "perfect-forecast upper bound" if only recorded weather is available.
  - AC-018.3: WHEN the backtest finishes THE SYSTEM SHALL report for Gemma E4B, Gemma E2B, the rule and the fixed routine: chores skipped, chores avoided, time, water and electricity saved, plant-risk days (simulated days where a strategy skipped watering and doing nothing did not work for the plants), and band calibration with N per band; results on Apr–Aug are labelled "in-sample" for the fine-tuned model and for rule thresholds, and the headline comparison uses Sep–Oct only.
  - AC-018.4: THE SYSTEM SHALL use no photos and no household data in the backtest.

### REQ-019: Fine-tuned bookmaker
- Story: As the builder, I want a bookmaker fine-tuned on Barcelona weather outcomes, so that the post can show whether a small open model improves with open data.
- Priority: Should
- Goals: G-2, G-4
- Acceptance criteria:
  - AC-019.1: WHEN the training dataset is built THE SYSTEM SHALL pair each day's archived forecast (text) with whether doing nothing worked from recorded weather, using Apr–Aug 2026 for training and Sep–Oct 2026 as hold-out, with no date in both.
  - AC-019.2: WHEN training finishes THE SYSTEM SHALL produce a merged GGUF model that loads in the local runtime and answers the bookmaker schema.
  - AC-019.3: WHEN the evaluation runs THE SYSTEM SHALL report band calibration with N per band, Brier score and the tool-call miss rate for base and fine-tuned E4B on the hold-out.
  - AC-019.4: WHERE the fine-tuned model is enabled THE SYSTEM SHALL record its model version on each bet it priced.
  - AC-019.5: WHEN target bands are computed THE SYSTEM SHALL use success rates from Apr–Aug 2026 only, so no hold-out day influences any training target.
  - AC-019.6: WHEN a training row is built THE SYSTEM SHALL render it as the same conversation the live bookmaker sees (including the rule band and the `get_forecast` tool call and result), and add a templated `disagreement_reason` whenever the target band is two or more bands from the rule band.

### REQ-020: Score screen
- Story: As a household member and post reader, I want a score screen with points, savings and how honest Gemma is, so that the results are visible in one place.
- Priority: Should
- Goals: G-3, G-4
- Acceptance criteria:
  - AC-020.1: WHEN the user opens Score THE SYSTEM SHALL show total points, savings tiles (chores skipped, water, electricity, net time back with its note) and the judge overrule rate with N.
  - AC-020.2: WHEN the user opens Score THE SYSTEM SHALL show band calibration (predicted odds vs share where doing nothing worked) separately for Gemma and the rule, with N per band.
  - AC-020.3: IF a band has fewer than 5 settled bets THEN THE SYSTEM SHALL show its N and mark it "too few to judge".
  - AC-020.4: WHEN there are no settled bets THE SYSTEM SHALL show an empty state instead of the chart.

### REQ-021: Laundry planner
- Story: As a household member, I want to know whether to wash today, wait, or give up on outdoor drying this week, so that loads dry outside.
- Priority: Could
- Goals: G-2, G-3
- Acceptance criteria:
  - AC-021.1: WHEN the user adds a laundry chore THE SYSTEM SHALL ask the Gemma laundry planner to score drying weather for the next 4 days and show Wash today, Skip today or No good day.
  - AC-021.2: WHEN the planner suggests Skip today THE SYSTEM SHALL first ask "Need anything washed before <day>?"; if yes, it SHALL show Wash today instead.
  - AC-021.3: WHEN the user follows Wash today on the best drying day THE SYSTEM SHALL add +5 points; Wash today and No good day are never bets.
  - AC-021.4: WHEN a Skip today bet settles THE SYSTEM SHALL count it a win only if the load dried outside on the chosen day.

### REQ-022: Rescue alerts and cash-out
- Story: As a household member, I want a warning when the forecast turns against an open bet, so that I can fold for a small cost.
- Priority: Could
- Goals: G-3
- Acceptance criteria:
  - AC-022.1: WHILE a bet is open THE SYSTEM SHALL re-check the forecast at least every hour and show a rescue alert on the slip if the rule band for the remaining window drops two or more bands below the bet's band.
  - AC-022.2: WHEN the user cashes out THE SYSTEM SHALL settle the bet at −10 points with no savings.

### REQ-023: Appeal a verdict
- Story: As a household member, I want to appeal a verdict once with a new photo, so that a judge mistake can be corrected.
- Priority: Could
- Goals: G-4
- Acceptance criteria:
  - AC-023.1: WHEN the user appeals a settled bet with a new photo THE SYSTEM SHALL re-judge it, replace the points with the new verdict, and mark the second verdict final.
  - AC-023.2: IF a bet has already been appealed THEN THE SYSTEM SHALL not offer another appeal.
  - AC-023.3: WHEN an appeal changes the verdict THE SYSTEM SHALL count it as an overrule for the judge agreement metric.

### REQ-024: Onboarding and habit baseline
- Story: As a new user, I want to say what is outside my door and how I usually do these chores, so that savings are measured against my habits.
- Priority: Could
- Goals: G-3, G-4
- Acceptance criteria:
  - AC-024.1: WHEN the app is opened for the first time THE SYSTEM SHALL ask for outdoor items, dryer type (none / heat pump / vented), AC and heater use, and location.
  - AC-024.2: WHEN onboarding is skipped or not built THE SYSTEM SHALL use the baseline in the config file (A-6).

### REQ-025: Ranks and achievements
- Story: As a household member, I want ranks and achievements, so that the game has a sense of progress.
- Priority: Could
- Goals: G-3
- Acceptance criteria:
  - AC-025.1: THE SYSTEM SHALL show the rank for the points total: Hyperactive squirrel (0), Koala (200), Three-toed sloth (600), Grand master of inaction (1,800).
  - AC-025.2: WHEN a condition is first met THE SYSTEM SHALL unlock the achievement once: First nap (first win), Cloud whisperer (win at odds ≤ 40%), Sky freeloader (three wins in a row), Knows when to fold (first cash-out).

### REQ-026: Split-flap weather board
- Story: As a household member, I want a weather board with today's lazy window, so that I can see at a glance when the sky is doing chores.
- Priority: Could
- Goals: G-1
- Acceptance criteria:
  - AC-026.1: WHEN the user opens Today THE SYSTEM SHALL show the current temperature and condition as split-flap tiles and hourly bars marking the lazy window.
  - AC-026.2: WHILE the device prefers reduced motion THE SYSTEM SHALL change tiles without the flip animation.

### REQ-027: Voice capture through Gemma
- Story: As a household member on the balcony, I want to say my chores, so that capture is hands-free.
- Priority: Could
- Goals: G-2
- Acceptance criteria:
  - AC-027.1: WHEN the user records a voice note THE SYSTEM SHALL send the audio only to the local runtime (Gemma 4 audio, or whisper.cpp as a stated fallback) and show the transcript with chores highlighted before creating cards.
  - AC-027.2: THE SYSTEM SHALL never send audio off the laptop.
  - AC-027.3: IF microphone access is unavailable (e.g. plain HTTP) THEN THE SYSTEM SHALL hide the mic button and keep typed capture.

### REQ-028: Show Gemma's reasoning
- Story: As a post reader, I want to see what Gemma saw and why it decided, so that its role is visible and checkable.
- Priority: Must
- Goals: G-2, G-4
- Acceptance criteria:
  - AC-028.1: WHEN a bet sheet or settle screen shows a Gemma decision THE SYSTEM SHALL show "What Gemma saw" / "Gemma's read" with its observations, the weather numbers it used and its reason.
  - AC-028.2: THE SYSTEM SHALL store with every Gemma decision the job, model version, prompt version, latency and raw validated output, for evaluation.

### REQ-029: Feature flags for unfinished work
- Story: As the builder, I want unfinished features hidden behind flags, so that the app stays working at the feature freeze.
- Priority: Must
- Goals: G-1
- Acceptance criteria:
  - AC-029.1: THE SYSTEM SHALL read feature flags from `config/flags.json`; every Should and Could feature has a flag that is off by default, and only the builder turns a flag on after merging and checking the feature.
  - AC-029.2: WHILE a flag is off THE SYSTEM SHALL show no UI entry point and expose no route for that feature.

## Non-functional requirements
| ID | Category | Requirement (measurable) | Verification |
|---|---|---|---|
| NFR-001 | Security | App server binds only to 127.0.0.1 and the home-LAN interface; the model runtime binds only to 127.0.0.1. All routes require a session (REQ-001). Token ≥ 128 bits CSPRNG, constant-time comparison. 0 high/critical findings in `npm audit --audit-level=high`; gitleaks clean. Known limit (plain HTTP cookie sniffing on the LAN) documented in README with the Tailscale Serve option. | Integration tests for 401/403/rate limit; `ss -ltnp` check during setup; CI audit and gitleaks |
| NFR-002 | Privacy / data classification | Photos, chore text, habits and audio are **household-private**: stored only in the git-ignored data folder, never sent off the laptop. Committed test fixtures are recorded only from staged or synthetic inputs and reviewed by hand. The only outbound host at runtime is Open-Meteo, with coordinates rounded to 2 decimals. 0 analytics or telemetry. Photos EXIF-stripped and ≤ 1024 px. | Test that stored photos have no EXIF; network capture during one capture → settle cycle shows only Open-Meteo hosts |
| NFR-003 | Reliability | 100% of open bets and their settle times survive a server or laptop restart, and every schema migration keeps existing rows (tested on a copy of the live database before it is applied). With Open-Meteo down, odds use the cached forecast (REQ-014); with Gemma down, odds fall back to the rule and settlements wait (REQ-013, AC-008.8). SQLite writes are transactional. | Restart test with open bets; fault-injection tests for weather and Gemma offline |
| NFR-004 | Performance | Rule odds on a new card ≤ 1 s (AC-004.1). Photo judgement (inspector + bookmaker, incl. the tool call) ≤ 15 s in ≥ 19 of 20 tries on the builder's laptop; each model call times out at 30 s and each Gemma job at 45 s. Schema-valid JSON ≥ 19 of 20 per job. App screens interactive ≤ 3 s on the phone over home Wi-Fi. | T-001 spike measurements, re-run before the freeze; logged latencies (NFR-007) |
| NFR-005 | Scale | Sized for 1 household, ≤ 3 paired devices, ≤ 100 bets/week (design assumption, not enforced). Backtest (Apr–Oct 2026, all supported chores, E4B + E2B + fine-tuned) completes in ≤ 8 h on the laptop, resumable, paused from 07:00 so morning settlements get the GPU. | Backtest run time and call-count estimate in T-015 |
| NFR-006 | Cost | 0 € running cost; Open-Meteo ≤ 1,000 calls/day (limit 10,000); fine-tune on the laptop GPU, Colab free tier as fallback. | Call counter in logs |
| NFR-007 | Observability | Local structured JSON logs; every Gemma call logs job, model version, prompt version, latency, schema-valid flag and retries; never tokens, session IDs or photo bytes. Gemma status visible in the UI (AC-013.5). | Log inspection test |
| NFR-008 | Compliance / licensing | Repo MIT; README lists third-party licences (Gemma 4 Apache 2.0, Open-Meteo CC BY 4.0 non-commercial, fonts SIL OFL, Lucide ISC). Points only: no stakes, purchases or value. Challenge rules (repo window, public, tags) met. | Release checklist before publishing |
| NFR-009 | Accessibility | WCAG 2.2 AA on all mobile screens: text contrast ≥ 4.5:1 (use `ink-3-text`, `amber-text` tokens), touch targets ≥ 44 × 44 px, win/lose never by colour alone, odds always with words, `prefers-reduced-motion` respected. | `ux-reviewer` pass; automated contrast check on tokens |
| NFR-010 | Testability | Every Gemma job runs against a fake returning recorded JSON fixtures; CI runs with no GPU, no model and no network. Points, rule baseline, settlement and savings logic have unit tests covering every AC above. | CI green without GPU or network |
| NFR-011 | Portability / setup | Supported: Windows 11 + WSL2 (Ubuntu), NVIDIA GPU ≥ 8 GB VRAM, ≥ 16 GB RAM [ASSUMPTION A-11], Node.js LTS; phone: current iOS Safari or Android Chrome. Model pinned by tag and digest. From a clean clone, setup (excluding model download) ≤ 30 min following the README. | Fresh-clone run-through before publishing |
| NFR-012 | Reproducibility | Backtest and fine-tune evaluation are reproducible: pinned model digests, fixed seeds, fixed date split, weather data snapshot saved with attribution; re-running gives the same reported numbers. | Re-run from the snapshot matches the report |

## Out of scope
- Push notifications and service workers: need HTTPS; polling while the app is open is enough for one household (closes Q-6).
- Browser Web Speech API for voice: sends audio to Google, breaking G-5.
- Cloudflare quick tunnels: public, and route home photos through a third party; Tailscale Serve is the HTTPS fallback.
- Everything listed under Non-goals in [product.md](product.md#non-goals-explicitly-out-of-scope).

## Open questions (requirements)
- [x] Q-12: Source of "recorded weather" at settle time: the forecast API's past hours, labelled "modelled recent weather"; the backtest uses the archive (answered 2026-10-21, ADR-0008).

## Assumptions (requirements)
- A-9: Undo is available for 5 minutes after placing; after that, cash-out is the way out (stops undoing bets that are going badly).
- A-10: Without a forecast younger than 24 h, no new bets are allowed (odds would be meaningless); existing bets are unaffected.
- A-11: The builder's laptop has ≥ 16 GB RAM (VRAM 8 GB+ confirmed).
