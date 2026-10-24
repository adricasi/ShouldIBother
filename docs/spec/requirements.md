# Requirements: Should I Bother?

- Status: Approved (2026-10-21) <!-- Draft | In review | Approved -->
- Last updated: 2026-10-24 (hosted mode)

IDs are permanent: never renumber or reuse. Deprecate with ~~strikethrough~~ and a note.
Acceptance criteria use EARS style: `WHEN <trigger> [WHILE <state>] THE SYSTEM SHALL <response>`
(or `IF <unwanted condition> THEN THE SYSTEM SHALL <response>`). Each one must be testable.

Priority follows the build order in [product.md](product.md#scope): **Must** = tiers 1–2 (core loop) plus safety, security and privacy; **Should** = tiers 3–4; **Could** = tiers 5–6. Nothing is cut: unfinished items at the feature freeze ship behind a flag, off by default (REQ-029).

Fixed values used below:
- **Odds bands → odds**: very likely 85 · likely 70 · toss-up 50 · unlikely 35 · very unlikely 15 (%, chance that doing nothing works).
- **Payout on a do-nothing win**: (100 − odds) × evidence multiplier, rounded to the nearest integer (halves up). Multiplier: after photo ×1.0, one tap ×0.5, auto-settle ×0.5.
- **Other outcomes**: small loss −25 · normal loss −50 · harmful loss −150 · cash-out −10 · "I'll do it" and the weather would not have helped +5 · "I'll do it" and the weather would have done it −10 · advice followed +5.
- **Gemma timeouts**: 30 s per model call; 45 s deadline per Gemma job end to end, measured from when the job is queued (so it includes waiting for the GPU) and covering all calls, tool calls and the retry; for a photo, inspector + bookmaker together. Gemma jobs run one at a time through one queue that holds at most 8 jobs (queued or running); a ninth is refused as "busy" (AC-013.6).
- **Retry budget**: each Gemma job makes at most 4 model calls: up to 2 for the first attempt (a `get_forecast` tool call and the answer) and up to 2 for its single retry. Every "retry once" below uses this budget.
- **Time zone**: all times, windows, settle bounds and the Monday–Sunday week are Europe/Madrid.

## Functional requirements

### REQ-001: Pair a device
- Story: As the household owner, I want only my own phone and laptop to open the app, so that nobody else on the Wi-Fi sees photos of my home or places bets.
- Priority: Must
- Goals: G-5
- Acceptance criteria:
  - AC-001.1: WHEN the server starts or the user runs `sib pair` THE SYSTEM SHALL generate a new pairing token of at least 128 bits from a cryptographically secure random source, valid for 10 minutes, print a pairing URL and QR code to the laptop console, and leave existing sessions valid.
  - AC-001.2: WHEN a device opens the pairing URL with a valid, unexpired token THE SYSTEM SHALL set an HttpOnly, SameSite=Strict session cookie and redirect to a URL that does not contain the token; one token may pair at most 3 devices within its 10 minutes, and each new pairing prints a console line with the time, client address and user agent.
  - AC-001.3: IF a request to any route other than `/pair` (pages, API, photo files) lacks a valid session THEN THE SYSTEM SHALL respond 401 and return no app data; `/healthz` is such a route and needs a session too (hosted mode: AC-032.7).
  - AC-001.4: IF a POST, PUT or DELETE request carries no Origin header, or one that is not an app origin (an allowlisted host over http, or an entry of `config.publicOrigins` such as a Tailscale Serve https origin) THEN THE SYSTEM SHALL reject it with 403.
  - AC-001.5: IF more than 10 unauthenticated requests that fail the pairing or session check arrive from one client address within 1 minute THEN THE SYSTEM SHALL reject further unauthenticated requests from that address for 1 minute; requests with a valid session are never rejected by this limit.
  - AC-001.6: WHEN the user runs "Forget devices" (in the app or `sib forget-devices`) THE SYSTEM SHALL invalidate all existing sessions and any unexpired pairing token.
  - AC-001.7: THE SYSTEM SHALL never write the pairing token or session identifiers to logs, including the `/pair` query string in request logs.
  - AC-001.8: IF a session is older than 30 days or a pairing token is older than 10 minutes THEN THE SYSTEM SHALL treat it as invalid.
  - AC-001.9: IF a request's Host header (with port) is not in the allowlist built at start-up (localhost, 127.0.0.1, the active interfaces' addresses, `config.allowedHosts` and the hosts of `config.publicOrigins`) THEN THE SYSTEM SHALL respond 421 and return no app data. `config.publicOrigins`, `config.allowedHosts` and the port are read from `config/server.json`, which is git-ignored because it names the machine; the committed `config/server.example.json` is the fallback.
  - AC-001.10: WHEN a device pairs through an https entry of `config.publicOrigins` THE SYSTEM SHALL also set the Secure attribute on the session cookie.

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
  - AC-003.3: WHEN the bookmaker answers "unsure" with a yes/no question THE SYSTEM SHALL show the question inside the card as two tap answers and re-ask the bookmaker with the answer. A card asks at most 2 questions (at most 3 answers are ever stored); if the questions are spent without a usable answer, the rule odds stay.
  - AC-003.4: IF the bookmaker's answer fails schema validation after one retry THEN THE SYSTEM SHALL keep the rule odds on the card (REQ-013) and log the failure.
  - AC-003.5: THE SYSTEM SHALL show plain words next to every odds percentage (e.g. "Likely · 70%").
  - AC-003.6: (With injected tool use, `tool_mode = injected`, the app makes the call and this AC does not apply; design.md Gemma jobs.) IF the bookmaker answers without calling the `get_forecast` tool THEN THE SYSTEM SHALL retry once and, if the tool is still not called, keep the labelled rule odds (REQ-013) and record the miss for the tool-call miss rate. The decision's `tool_mode` is `called` only after a valid call to `get_forecast` (right tool, valid arguments) that ran.

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
  - AC-005.2: WHEN a photo is stored THE SYSTEM SHALL ask the Gemma inspector for its observations (item type, soil dryness or dampness, wilting, cover from rain) and re-run the bookmaker with them. A new before photo replaces the card's earlier one together with its quotes and Gemma decisions, so the odds before the photo are always the odds without any photo.
  - AC-005.3: WHEN the bookmaker returns odds after a photo THE SYSTEM SHALL show a "What Gemma saw" list and the odds before → after (e.g. "35% → 50%").
  - AC-005.4: IF the inspector answers "unsure" (e.g. too dark) THEN THE SYSTEM SHALL keep the odds without the photo and show Gemma's yes/no question as text only, with no tap answers; it does not count toward the card's 2 questions (AC-003.3).
  - AC-005.5: WHEN a bet is placed with a photo THE SYSTEM SHALL store the odds band with and without the photo, for the photo ablation.
  - AC-005.6: IF an uploaded file is not a JPEG, PNG, WebP or HEIF image (decided by its first bytes, not its name or declared type; every other decoder is disabled) or the system cannot decode it (e.g. HEIC without decoder support) THEN THE SYSTEM SHALL respond 415 with a message telling the user how to send a supported photo, and keep the card unchanged. Only one photo is processed at a time: a second upload during that responds 409 and changes nothing.

### REQ-006: Bet, do it, or undo
- Story: As a household member, I want to bet on doing nothing or say I'll do the chore, so that each decision is recorded and later scored.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-006.1: WHEN the user taps "Bet: do nothing" THE SYSTEM SHALL create a bet from the quote the user was looking at (the request names the card, that quote and the kind) with that quote's odds, band, odds source, reason and settle time, and lock them; IF that quote is no longer the card's latest quote, or its settle time has passed, THEN THE SYSTEM SHALL respond 409 and create no bet.
  - AC-006.2: WHEN the forecast or Gemma's answer changes after a bet is placed THE SYSTEM SHALL NOT change that bet's odds, band or payouts; a Gemma answer that arrives after a bet was placed on the card is discarded (the card is marked `superseded`, and Retry works again if the bet is undone).
  - AC-006.3: WHEN the user taps "I'll do it" THE SYSTEM SHALL record a do-it decision from the quote the user saw (same request as AC-006.1) with the same odds and settle time, to be scored at settlement (REQ-009).
  - AC-006.4: WHEN the user taps Undo within 5 minutes of placing a bet or do-it decision (up to and including the fifth minute: the boundary instant still counts) THE SYSTEM SHALL mark it undone, with no points and no savings, and free the card for a new bet [ASSUMPTION A-9].
  - AC-006.5: IF the user tries to undo more than 5 minutes after placing, or once the bet is no longer open, THEN THE SYSTEM SHALL not offer Undo and respond 409 to the request; the bet is locked (cash-out applies only when REQ-022 is enabled).

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
  - AC-008.5: WHEN the judge returns "unsure" THE SYSTEM SHALL ask the user its yes/no question and re-judge with the answer; the judge asks at most 2 questions per bet and must decide after that.
  - AC-008.6: WHEN a do-nothing bet is settled as a win and the recorded weather does not meet the chore's outcome label (design.md, Outcome labels) THE SYSTEM SHALL mark it a lucky win (computed by code, not by Gemma), pay it as a win, count it as a success in calibration like every other win, and report the lucky-win share separately. The label is applied to the chore's full fixed outcome window on the day the bet was placed (hours before the bet was placed come from the recorded weather too), cut only at the end where the hours are not recorded yet.
  - AC-008.7: IF a bet has no user answer 24 h after its settle time THEN THE SYSTEM SHALL have the judge settle it from the recorded weather alone, at the ×0.5 multiplier. An answer sent 24 h or more after the settle time is refused with 409 and changes nothing; a judge question still open at that point is cleared, and the judge decides without asking.
  - AC-008.8: IF Gemma is unavailable when a bet needs a verdict THEN THE SYSTEM SHALL keep the bet in "Settle when Gemma is back" and never settle it with the rule model; when Gemma returns it SHALL judge it, retrying a failed bet every 2 minutes. A verdict committed at or after the settle time + 24 h pays a win at ×0.5 whatever the evidence; the settlement keeps the evidence type and is flagged `multiplier_capped`.
  - AC-008.9: WHEN a do-it decision reaches its settle time THE SYSTEM SHALL have the judge decide from the recorded weather whether the weather would have done the chore.

### REQ-009: Points
- Story: As a household member, I want points that reward correct laziness and punish wrong laziness, so that skipping only pays when it is smart.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-009.1: WHEN a do-nothing bet is settled as a win THE SYSTEM SHALL add (100 − odds) × multiplier points, rounded to the nearest integer (halves up).
  - AC-009.2: WHEN a do-nothing bet is settled as a small, normal or harmful loss THE SYSTEM SHALL add −25, −50 or −150 points respectively, regardless of the evidence multiplier.
  - AC-009.3: WHEN a do-it decision is settled THE SYSTEM SHALL add +5 if the weather would not have done the chore and −10 if it would have.
  - AC-009.4: THE SYSTEM SHALL compute the points total from the stored outcomes, so the total equals the sum of settled bets plus cash-outs plus advice followed (each bet counted once, by its final settlement).

### REQ-010: PAID OUT receipt
- Story: As a household member, I want a payout receipt when I win, so that the win feels like one and shows what it saved.
- Priority: Must
- Goals: G-1, G-3
- Acceptance criteria:
  - AC-010.1: WHEN a do-nothing bet is settled as a win THE SYSTEM SHALL show a receipt with the bet, odds, evidence type, recorded weather, points won, time saved and water or electricity saved, with a "PAID OUT" stamp.
  - AC-010.2: WHEN a bet is settled as a loss THE SYSTEM SHALL show the result with its points and reason, using the fixed loss copy strings reviewed by `ux-reviewer`, without the PAID OUT stamp.

### REQ-011: Savings totals
- Story: As a household member, I want to see the time, water and electricity the weather saved me, so that I know laziness was worth it.
- Priority: Must
- Goals: G-3, G-4
- Acceptance criteria:
  - AC-011.1: WHEN a do-nothing bet is settled as a win THE SYSTEM SHALL add the chore's catalogue savings (time, water, electricity), using the household baseline, to the totals.
  - AC-011.2: THE SYSTEM SHALL count no savings for losses, do-it decisions or undone bets.
  - AC-011.3: THE SYSTEM SHALL report net time back as time saved minus 30 s per bet or do-it decision placed and not undone, and show both parts (e.g. "2 h 10 saved, minus 6 min spent on 12 bets").
  - AC-011.4: THE SYSTEM SHALL count time only for skipped steps; electricity-only savings (e.g. line instead of dryer) add 0 minutes.
  - AC-011.5: THE SYSTEM SHALL show the assumption behind each savings figure where it is displayed (e.g. "vs a heat-pump dryer, ~2 kWh"); a figure without a cited source is labelled "typical estimate" (e.g. the condenser dryer).
  - AC-011.6: WHEN the user opens Today THE SYSTEM SHALL show this week's totals (Monday–Sunday, Europe/Madrid): net time back, water in litres and electricity in kWh. A bet counts, whole (its 30 s included), in the week of its settle time, so a bet placed on Sunday night and settled on Monday counts in Monday's week.
  - AC-011.7: WHEN a card offers a do-nothing bet THE SYSTEM SHALL show what a win would save (time, water, electricity from the same catalogue and household baseline as AC-011.1, with its assumption as in AC-011.5), worded as an estimate ("saves ~5 min · ~5 L water if the sky does it"); the estimate is computed by code, equals the `savings_snapshot` a bet placed from that quote would store, omits time when it is 0 (AC-011.4), and nothing is added to any total until the bet wins; a placed bet shows its stored snapshot, not a recomputed estimate.

### REQ-012: Safety is never a bet
- Story: As a household member, I want risky weather to tell me to act, so that the game never puts plants or people at risk.
- Priority: Must (fixed backstop, AC-012.1–012.2) · Should (Gemma safety guard, AC-012.3–012.4; tier 3)
- Goals: G-2, G-3
- Acceptance criteria:
  - AC-012.1: IF the forecast for a card's window crosses a fixed heat, frost or storm limit (values in design.md, Q-5) THEN THE SYSTEM SHALL show a "Do it now" alert with the reason and no bet action, whatever Gemma's answer. The check also covers the window of the settle time Gemma chose: if heat, frost or storm shows up there, the card becomes the alert instead of getting Gemma's odds.
  - AC-012.2: IF a request to place a bet arrives for a card in alert state THEN THE SYSTEM SHALL reject it.
  - AC-012.3: WHEN a card is created THE SYSTEM SHALL ask the Gemma safety guard whether the chore touches safety (heat, frost, storm, vulnerable people) and, if it says yes, show a "Do it now" alert with its reason and no bet action. The guard answers `status: ok|unsure`; `unsure` is no verdict and leaves the card as it is. Betting stays allowed while the guard runs, and a guard alert always wins: it sets every open bet on the card to `undone` (a withdrawal by the system, separate from the 5-minute user undo of AC-006.4, with no points and no savings) and turns the card into the alert; when a bet was withdrawn, the reason ends with "Your bet was withdrawn for safety."
  - AC-012.4: IF the safety guard is unavailable (offline, busy, late, invalid or unsure) THEN THE SYSTEM SHALL still apply the fixed backstop (AC-012.1). `cards.safety_checked_at` is set only when the guard gives a verdict; while it is NULL, Retry asks the guard again, and so does a restart that lost the guard's job (for a card that has no bet yet and whose odds have not run out).

### REQ-013: Rule odds while Gemma thinks or is offline
- Story: As a household member, I want odds at once even when Gemma is slow or down, so that the app never blocks me.
- Priority: Must
- Goals: G-3
- Acceptance criteria:
  - AC-013.1: WHEN a weather chore card is created THE SYSTEM SHALL show the rule band at once, labelled "Gemma is thinking · rule odds".
  - AC-013.2: WHEN Gemma's answer arrives before a bet is placed THE SYSTEM SHALL replace the rule band, reason and settle time with Gemma's and label the card "Gemma's odds".
  - AC-013.3: IF the Gemma job does not finish within its 45 s deadline or Gemma is not running THEN THE SYSTEM SHALL label the card "Gemma offline · rule odds", offer Retry, and still allow betting; a model runtime that is not running (Ollama down) shows the same label.
  - AC-013.4: WHEN a bet is placed on rule odds THE SYSTEM SHALL store odds_source = rule; such bets count for points, savings and the rule's calibration, and are excluded from Gemma's calibration and the base-vs-fine-tuned comparison.
  - AC-013.5: WHILE the app is open THE SYSTEM SHALL show Gemma's status (online / offline) on Today, refreshed at least every 60 s.
  - AC-013.6: IF 8 Gemma jobs are already queued or running THEN THE SYSTEM SHALL refuse listener capture, Retry, an answer to Gemma's question, a settle answer and a photo upload with 503 "Gemma is busy" before any state changes; a quick-chip card is still created with its rule odds and reads "Gemma offline · rule odds" with the note that Gemma is busy, and a bet waiting for a verdict stays in "Settle when Gemma is back".

### REQ-014: Weather data
- Story: As a household member, I want the odds and settlements based on real forecasts and recorded weather for my neighbourhood, so that the bets are about my weather.
- Priority: Must
- Goals: G-3, G-4, G-5
- Acceptance criteria:
  - AC-014.1: WHEN the weather tool is called THE SYSTEM SHALL request the Open-Meteo forecast for the household's configured coordinates, rounded to 2 decimal places.
  - AC-014.2: WHEN a forecast is fetched THE SYSTEM SHALL cache it with its fetch time and reuse it for at most 1 h.
  - AC-014.3: IF Open-Meteo is unreachable THEN THE SYSTEM SHALL use the latest cached forecast and show its age (e.g. "Forecast from 3 h ago").
  - AC-014.4: IF no forecast younger than 24 h is available THEN THE SYSTEM SHALL still create the card, showing "No forecast, can't set odds" with no odds and no bet action (the request succeeds with 201; the card has the kind `coming_later` and a notice, ADR-0009) [ASSUMPTION A-10].
  - AC-014.5: IF recorded weather for a bet's window is not yet available THEN THE SYSTEM SHALL keep the bet waiting and retry at least every 30 min.
  - AC-014.6: THE SYSTEM SHALL show the Open-Meteo attribution (CC BY 4.0) in the app and the README.
  - AC-014.7: THE SYSTEM SHALL send outbound requests only to the Open-Meteo hosts (and, in hosted mode only, DigitalOcean's inference host, AC-032.2) in the weather client's allowlist (forecast, Previous Runs, Historical Forecast and archive APIs, and the geocoding API for the onboarding place search, AC-024.4) and refuse any other host.

### REQ-015: Own and delete my data
- Story: As a household member, I want to delete photos and bets and export my data, so that I control what is kept about my home.
- Priority: Must
- Goals: G-5, G-4
- Acceptance criteria:
  - AC-015.1: THE SYSTEM SHALL store the database and photos in a data folder outside the source tree that is listed in `.gitignore`.
  - AC-015.2: WHEN the user deletes a photo or a bet in the app THE SYSTEM SHALL remove the photo file(s) and every record derived from them from disk: for a photo, its `photos` row, the `quotes` made with it and the inspector's and judge's `gemma_decisions` rows that used it (input_summary and output); for a bet, also its `bets`, `settlements`, quotes and decisions (SQLite `secure_delete` on, WAL checkpointed so deleted rows are overwritten), and recompute totals. Deleting a bet's data deletes its whole card (the chore text is household data too) with all the card's bets, including its other undone bets, quotes, photos and decisions; the one exception is an undone bet on a card that has a newer active bet, where only that bet's own rows and photos go and the card stays.
  - AC-015.3: WHEN the user runs `sib delete-photos` THE SYSTEM SHALL remove all photos, and with `--all-data` also the database (which holds the weather cache), after a confirmation prompt. The command refuses to run while the app is running (it needs exclusive use of the database) and deletes only the files the app owns in the data folder: `sib.db`, its `-wal` and `-shm` files and the photo files. Logs go to the terminal, so no log files exist to delete.
  - AC-015.4: WHEN the user runs `sib export <dir>` THE SYSTEM SHALL write a JSON file of all bets, decisions, verdicts and totals plus the photo files to a chosen folder. The command refuses to run while the app is running, and refuses a folder that is a symlink or is not empty (a new folder is created owner-only).

### REQ-016: Chores in this version
- Story: As a household member, I want bets for the chores I actually do this week, so that the live week produces real bets.
- Priority: Must (water balcony plants; line-dry today, skip the dryer) · Should (laundry: leave it out tonight) · Could (skip the AC, skip the heater, each offered only when the household baseline says it is used this season)
- Goals: G-3
- Acceptance criteria:
  - AC-016.1: THE SYSTEM SHALL support do-nothing bets for "water balcony plants" and "line-dry today (skip the dryer)", with catalogue savings and settle-time rules.
  - AC-016.4: WHEN the user creates a laundry card from 07:00 up to but not including 15:00 THE SYSTEM SHALL offer "Line-dry today (skip the dryer)", a bet that wins if the load is dry by its settle time (same day 18:00–21:00) and loses if it is still damp or rain wet it; its savings are the dryer's kWh from the household baseline and 0 minutes (AC-011.4). Outside that window the card says when it can be offered, with no odds and no bet action.
  - AC-016.5: IF the household baseline says the AC (or heater) is not used this season THEN THE SYSTEM SHALL show that chore as "Not needed this season" with no odds and no bet action (the baseline is `airConditioning` and `heaterThisSeason` in `config/household.json`; this check comes first). The one `heater` flag gates both seasonal chores: while it is off, a chore the household does use reads "Coming later".
  - AC-016.2: WHEN the user creates a "Leave it out tonight" card in [sunset − 1 h, sunset + 2 h) (lower bound included) THE SYSTEM SHALL offer a "Leave it out tonight" bet (outside that window the card says when it can be offered) that wins if the laundry is dry in the morning and loses if dew or rain dampened it. The card stores that day's sunset once (`cards.sunset_at`, write-once); its rule window, safety backstop and lucky-win label start at the stored sunset. Open-Meteo's daily `sunset` is requested only while the `laundryTonight` flag is on; for a day without one, the sunset is the start of the last `is_day` hour, and the fallback is logged.
  - AC-016.3: THE SYSTEM SHALL support a "skip the heater" bet settled by a one-tap comfort answer, offered only while the one `heater` flag is on (it gates the AC chore too, AC-016.5).

### REQ-017: PAID OUT stamp animation
- Story: As a demo viewer, I want the PAID OUT stamp to land, so that the win moment is memorable.
- Priority: Should
- Goals: G-1
- Acceptance criteria:
  - AC-017.1: WHEN the win receipt opens THE SYSTEM SHALL animate the stamp from scale 1.6 to 1 with a −8° rotation over 220–280 ms. The animation plays for a receipt just produced on Today and, on Slips, only for wins settled today (Europe/Madrid); older wins show the static stamp. The stamp rests at −8° and the code holds that angle for the whole animation (only the scale and the fade animate).
  - AC-017.2: WHILE the device prefers reduced motion THE SYSTEM SHALL show the stamp with a fade only.

### REQ-018: Backtest
- Story: As the builder, I want to replay six months of Gràcia weather, so that the post can compare Gemma, the rule and a fixed routine beyond one dry week.
- Priority: Should
- Goals: G-4
- Acceptance criteria:
  - AC-018.1: WHEN the backtest runs THE SYSTEM SHALL decide each simulated day only from forecasts issued by model runs that started before the decision time (Open-Meteo Previous Runs API, day-1 lead) at the chore's fixed decision time, and settle it with the chore's outcome label (design.md, Outcome labels) computed from recorded weather (archive).
  - AC-018.2: IF day-1-lead forecasts are not available for a variable THEN THE SYSTEM SHALL fall back to the Historical Forecast API and label the affected results "short-lead forecast (optimistic)", or "perfect-forecast upper bound" if only recorded weather is available. The headline tables and the calibration use day-1 days only; fallback days are reported separately under their label.
  - AC-018.3: WHEN the backtest finishes THE SYSTEM SHALL report for Gemma E4B, Gemma E2B, the rule and the fixed routine: skips (do-nothing decisions taken), skips that worked, time, water and electricity saved, plant-risk days (simulated days where a strategy skipped watering and the plants' outcome label was false), and band calibration with N per band over every day a strategy priced, not only its skips (the fixed routine has no odds: calibration n/a); a skip is a decision on a band of "likely" (70%) or better, the same for the rule and for Gemma; savings are measured against a baseline that does every chore every day it is in season, with a heat-pump dryer; the fine-tuned model's column comes from the hold-out evaluation (AC-019.3) and its Apr–Aug results, if shown, are labelled "in-sample"; the headline comparison uses Sep–Oct only.
  - AC-018.4: THE SYSTEM SHALL use no photos and no household data in the backtest.

### REQ-019: Fine-tuned bookmaker
- Story: As the builder, I want a bookmaker fine-tuned on Barcelona weather outcomes, so that the post can show whether a small open model improves with open data.
- Priority: Should
- Goals: G-2, G-4
- Acceptance criteria:
  - AC-019.1: WHEN the training dataset is built THE SYSTEM SHALL pair each day's Previous Runs day-1-lead forecast (as in AC-018.1) with the chore's outcome label from the archive, using 1 Apr–31 Aug 2026 for training and 1 Sep 2026 to the snapshot's last archive day as hold-out (that end date is recorded in the dataset manifest), with no date in both.
  - AC-019.2: WHEN training finishes THE SYSTEM SHALL produce a merged GGUF model that loads in the local runtime and answers the bookmaker schema.
  - AC-019.3: WHEN the evaluation runs THE SYSTEM SHALL report band calibration with N per band, Brier score and the tool-call miss rate for base and fine-tuned E4B on the hold-out.
  - AC-019.4: WHERE the fine-tuned model is enabled THE SYSTEM SHALL record its model version on each bet it priced.
  - AC-019.5: WHEN target bands are computed THE SYSTEM SHALL use success rates from Apr–Aug 2026 only, with the neighbour method in design.md (Fine-tune dataset), so no hold-out day influences any training target.
  - AC-019.6: WHEN a training row is built THE SYSTEM SHALL render it as the same conversation the live bookmaker sees (including the rule band and the `get_forecast` tool call and result), and add a templated `disagreement_reason` whenever the target band is two or more bands from the rule band; the habits in every row come from a fixed synthetic profile, never from `config/household.json`.
  - AC-019.7: WHEN the dataset is built THE SYSTEM SHALL write a manifest with the bookmaker prompt version, the `config/rules.json` hash, the snapshot end date, the synthetic habit profile and the number of rows per chore and band (training and hold-out).
  - AC-019.8: IF any value from `config/household.json` appears in a training or hold-out row THEN THE SYSTEM SHALL fail the dataset build.

### REQ-020: Score screen
- Story: As a household member and post reader, I want a score screen with points, savings and how honest Gemma is, so that the results are visible in one place.
- Priority: Should
- Goals: G-3, G-4
- Acceptance criteria:
  - AC-020.1: WHEN the user opens Score THE SYSTEM SHALL show total points, all-time savings tiles (chores skipped, water, electricity, net time back with its note) and the judge overrule rate with N, shown as "appeals off" while REQ-023 is disabled. N counts settled do-nothing bets whose first verdict is a Gemma decision (`decision_id` not null, not the fake model); any change of verdict by an appeal counts as an overrule (AC-023.3). Percentages are whole numbers, halves up, computed from the integer counts.
  - AC-020.2: WHEN the user opens Score THE SYSTEM SHALL show band calibration (predicted odds vs share where doing nothing worked) separately for Gemma and the rule, with N per band, over settled do-nothing bets only (do-it decisions, cash-outs and undone bets excluded): Gemma's calibration uses bets with `odds_source = gemma` and their Gemma band, and leaves out bets priced by the fake model (`model_version` like `fake%`); the rule's uses every settled do-nothing bet's rule band; every win counts as a success, lucky wins included.
  - AC-020.3: IF a band has fewer than 5 settled bets THEN THE SYSTEM SHALL show its N and mark it "too few to judge".
  - AC-020.4: WHEN there are no settled do-nothing bets THE SYSTEM SHALL show an empty state instead of the chart.

### REQ-021: Laundry planner
- Story: As a household member, I want to know whether to wash today, wait, or give up on outdoor drying this week, so that loads dry outside.
- Priority: Could
- Goals: G-2, G-3
- Acceptance criteria:
  - AC-021.1: WHEN the user adds a laundry chore THE SYSTEM SHALL ask the Gemma laundry planner to score drying weather for the next 4 days (named `day_0` today to `day_3`) and show Wash today, Skip today or No good day. Code checks that the answer agrees with its own scores (the best day has the best score; Wash today and Skip today need a day scoring toss-up or better; Skip today names a later day that beats today; No good day means no day better than unlikely); an inconsistent answer is invalid (one retry).
  - AC-021.2: WHEN the planner suggests Skip today THE SYSTEM SHALL first ask "Need anything washed before <day>?" (the "need it by" question: it is asked after the plan and is not an input of the planner); if yes, it SHALL show Wash today instead. IF the answer is no THEN THE SYSTEM SHALL first run the fixed backstop and the Gemma safety guard on the chosen day (asynchronously) and only then open the bet; an alert makes the card a "Do it now" alert. IF the plan's forecast is more than 1 h old, or the chosen day has reached 10:00, THEN THE SYSTEM SHALL refuse the answer with 409 and the person plans again.
  - AC-021.3: WHEN the user follows Wash today on the best drying day, before 18:00, THE SYSTEM SHALL add +5 points, at most once per Madrid day; the points are stored on the planner card and added to the points total (AC-009.4). Wash today and No good day are never bets.
  - AC-021.4: WHEN a Skip today bet settles THE SYSTEM SHALL count it a win only if the load dried outside on the chosen day.
  - AC-021.5: WHEN a Skip today bet is placed THE SYSTEM SHALL use the band the laundry planner gives for the chosen day's drying, mapped to the fixed odds, and store the day's rule band beside it. IF the planner's band is two or more bands from the rule band THEN THE SYSTEM SHALL require a `disagreement_reason` (or a question to the user, asked instead of showing the plan), as in AC-004.3.

### REQ-022: Rescue alerts and cash-out
- Story: As a household member, I want a warning when the forecast turns against an open bet, so that I can fold for a small cost.
- Priority: Could
- Goals: G-3
- Acceptance criteria:
  - AC-022.1: WHILE a bet on doing nothing is open and its settle time is ahead THE SYSTEM SHALL re-check the forecast every 30 min and show a rescue alert on the slip if the rule band for the remaining window drops two or more bands below the bet's band, or if the fixed heat, frost or storm backstop crosses its limit in the remaining window, even when the window cannot be priced. A Skip today bet's window is the chosen day, 10:00–18:00.
  - AC-022.2: WHEN the user cashes out, after a two-step confirm, THE SYSTEM SHALL settle the bet at −10 points with no savings. A bet can be cashed out only while it is open and before its settle time; do-it decisions cannot be cashed out (409). A cash-out is stored in its own table, not as a settlement (ADR-0010).

### REQ-023: Appeal a verdict
- Story: As a household member, I want to appeal a verdict once with a new photo, so that a judge mistake can be corrected.
- Priority: Could
- Goals: G-4
- Acceptance criteria:
  - AC-023.1: WHEN the user appeals a settled bet on doing nothing with a new photo THE SYSTEM SHALL re-judge it (prompt `judge-appeal.v1`), replace the points with the new verdict, and mark the second verdict final: the appeal row has `final = 1` and `appeal_of`, and the original becomes `final = 0`. Wins can be appealed, and an appeal can turn a win into a loss; there is no deadline. The 24 h cap of AC-008.8 applies: an appeal decided 24 h or more after the settle time pays a win at ×0.5, and the offer says so. IF the judge cannot answer THEN THE SYSTEM SHALL change nothing, delete the new photo and its decision, log the attempt, and not queue the appeal.
  - AC-023.2: IF a bet has already been appealed THEN THE SYSTEM SHALL not offer another appeal (the database allows one final row and one appeal row per bet).
  - AC-023.3: WHEN an appeal changes the verdict (any change, including one loss size to another) THE SYSTEM SHALL count it as an overrule for the judge agreement metric.

### REQ-024: Onboarding and habit baseline
- Story: As a new user, I want to say what is outside my door and how I usually do these chores, so that savings are measured against my habits.
- Priority: Could
- Goals: G-3, G-4
- Acceptance criteria:
  - AC-024.1: WHEN the app is opened for the first time THE SYSTEM SHALL ask for outdoor items, dryer type (none / heat pump / condenser / vented), AC and heater use, and location (entered as latitude and longitude text, rounded to 2 decimals before anything leaves the laptop). Outdoor items are stored but have no effect yet. An optional place label (AC-026.3) is asked next to the location. The location can also be chosen with "Use my location" (AC-024.3) or a place search (AC-024.4); typed coordinates stay as the fallback.
  - AC-024.3: WHERE the page runs in a secure context with the browser Geolocation API available (the laptop itself, or the Tailscale Serve HTTPS option) THE SYSTEM SHALL offer "Use my location", which asks for one position (no tracking), rounds latitude and longitude to 2 decimals in the browser before anything is sent, fills the location fields for the person to confirm, and stores nothing until they save; WHERE it is not available (plain HTTP on the LAN) THE SYSTEM SHALL hide the button and keep the search and typed coordinates.
  - AC-024.4: WHEN the person searches for a place (2 to 60 characters) THE SYSTEM SHALL ask Open-Meteo's geocoding API from the laptop (never from the page), show at most 10 results with name, region and country, and on a choice fill the location rounded to 2 decimals and offer the result's name as the place label (editable); the search text is sent only for that search, is not stored or logged, and is never part of a Gemma prompt; the search is limited to 10 requests per minute and refuses while the app holds no session.
  - AC-024.2: WHEN onboarding is skipped or not built THE SYSTEM SHALL use the baseline in the config file (A-6). A completed profile replaces the baseline for bets placed afterwards (a bet's savings snapshot stays write-once). A card keeps the location it was made under (`cards.location_lat` and `location_lon`, write-once, stamped only while the `onboarding` flag is on); settlement, the lucky-win label and rescue checks use the card's location.

### REQ-025: Ranks and achievements
- Story: As a household member, I want ranks and achievements, so that the game has a sense of progress.
- Priority: Could
- Goals: G-3
- Acceptance criteria:
  - AC-025.1: THE SYSTEM SHALL show the rank for the points total: Hyperactive squirrel (0), Koala (200), Three-toed sloth (600), Grand master of inaction (1,800); the ids are `hyperactive_squirrel`, `koala`, `three_toed_sloth`, `grand_master_of_inaction`, and a threshold includes its lower bound. The rank and the achievements appear on Score, so `ranks` needs `score` on.
  - AC-025.2: WHEN a condition is first met THE SYSTEM SHALL unlock the achievement once: First nap (first win), Cloud whisperer (win at odds ≤ 40%), Sky freeloader (three wins in a row), Knows when to fold (first cash-out). "In a row" counts settled do-nothing bets in the order of their first settlement (ties by bet id); a loss or a cash-out resets the streak, do-it decisions are ignored, and an appeal does not move a bet in the order. `unlocked_at` is the time of the event that met the condition. Unlocks are permanent, even after the bet's data is deleted or an appeal reverses the win.

### REQ-026: Split-flap weather board
- Story: As a household member, I want a weather board with today's lazy window, so that I can see at a glance when the sky is doing chores.
- Priority: Could
- Goals: G-1
- Acceptance criteria:
  - AC-026.1: WHEN the user opens Today THE SYSTEM SHALL show the current temperature and condition as split-flap tiles and hourly bars marking the lazy window. A lazy hour is a remaining daylight hour whose drying index is at or above the line-dry toss-up row of `config/rules.json` (0.30), clipped to 18:00. The board reads cached forecasts only and shows the forecast age when it is stale; the Open-Meteo attribution (AC-014.6) appears once, in the footer.
  - AC-026.2: WHILE the device prefers reduced motion THE SYSTEM SHALL change tiles without the flip animation.
  - AC-026.3: WHERE the household has a place label (optional free text set in onboarding, at most 40 characters, e.g. "Gràcia · Barcelona") THE SYSTEM SHALL show it in the weather board header; the label is stored on the laptop only; it is not geocoded and never appears in an Open-Meteo request, a Gemma prompt, `gemma_decisions`, a log line or a dataset row; it is trimmed, may not contain control characters, and its 40-character limit counts code points; it is included in `sib export` and deleted by `sib delete-photos --all-data`; `sib demo` uses a synthetic label.

### REQ-027: Voice capture through Gemma
- Story: As a household member on the balcony, I want to say my chores, so that capture is hands-free.
- Priority: Could
- Goals: G-2
- Acceptance criteria:
  - AC-027.1: WHEN the user records a voice note THE SYSTEM SHALL send the audio only to the local runtime (Gemma 4 audio, or whisper.cpp as a stated fallback) and show the transcript with chores highlighted before creating cards.
  - AC-027.2: THE SYSTEM SHALL never send audio off the laptop.
  - AC-027.3: IF microphone access is unavailable (always on plain HTTP; voice needs the Tailscale Serve HTTPS option) THEN THE SYSTEM SHALL hide the mic button and keep typed capture.

### REQ-028: Show Gemma's reasoning
- Story: As a post reader, I want to see what Gemma saw and why it decided, so that its role is visible and checkable.
- Priority: Must
- Goals: G-2, G-4
- Acceptance criteria:
  - AC-028.1: WHEN a card or settle screen shows a Gemma decision THE SYSTEM SHALL show "What Gemma saw" / "Gemma's read" with its observations, the weather numbers it used and its reason.
  - AC-028.2: THE SYSTEM SHALL store with every Gemma decision the job, model version, prompt version, latency and its raw output (the last answer, whether or not it passed validation, with the validation result), for evaluation; a voice transcript is never stored (AC-027.2).
  - AC-028.3: WHEN a slip, a waiting bet or a receipt shows odds THE SYSTEM SHALL say whose odds they are ("Gemma's odds" or "Rule odds" from `odds_source`), and WHEN Gemma's band differs from the rule's THE SYSTEM SHALL show both bands side by side with Gemma's reason.
  - AC-028.4: WHEN a Gemma decision is shown THE SYSTEM SHALL offer a "How Gemma decided" disclosure with the model tag and short digest, the prompt version, whether the forecast tool was called (`tool_mode`), the forecast numbers returned to Gemma, retries and latency, read from `gemma_decisions`; nothing in it is sent anywhere.

### REQ-029: Feature flags for unfinished work
- Story: As the builder, I want unfinished features hidden behind flags, so that the app stays working at the feature freeze.
- Priority: Must
- Goals: G-1
- Acceptance criteria:
  - AC-029.1: THE SYSTEM SHALL read feature flags from `config/flags.json`; every Should and Could feature has a flag that is off by default, and only the builder turns a flag on after merging and checking the feature.
  - AC-029.2: WHILE a flag is off THE SYSTEM SHALL show no UI entry point and expose no route for that feature.
  - AC-029.3: THE SYSTEM SHALL provide `sib flags` on the laptop to list the flags and turn them on or off in `config/flags.json`, including presets read from `config/flags.presets.json`, an explicit list of flag names per preset that the builder edits; the `presentation` preset lists every merged feature except `voice` and `finetunedBookmaker`, which need the laptop checks of T-028 and T-014 and are turned on by name; the committed defaults in `config/flags.json` stay off (AC-029.1), and applying a preset is the builder turning flags on.
  - AC-029.4: THE SYSTEM SHALL provide `sib demo` to run the app for rehearsals and screenshots on a separate temporary data folder seeded with synthetic bets, with the fake model, fake weather and the flags of the `presentation` preset (AC-029.3) applied in memory; every screen shows a fixed "Sample data" banner, the Score tiles and calibration chart carry a "SAMPLE" watermark, and `sib export` refuses in demo mode; it never reads or writes the live data folder or `config/household.json`; the seeded rows carry `model_version = 'fake-demo'` and Score counts them only in demo mode, labelled "Sample data · fake model" (NFR-010); its numbers are never reported as results (G-1).

### REQ-030: City rain bets
- Story: As a household member in a city flat, I want to bet that the rain rinses the car, the bike and the terrace or fills the rain barrel, so that I skip those chores when the sky does them.
- Priority: Could
- Goals: G-1, G-3
- Acceptance criteria:
  - AC-030.1: WHILE the `rainChores` flag is on THE SYSTEM SHALL offer four more do-nothing bets: rinse the car (`car_rinse`), rinse the bike (`bike_rinse`), rinse the terrace or outdoor furniture (`terrace_rinse`) and fill the rain barrel, pond or bird bath (`rain_fill`). They are priced, placed, settled and paid like the plants bet (REQ-004 to REQ-011), with the rule baseline, outcome labels, settle bounds, judge answers and savings in design.md (City rain bets); WHILE the flag is off they are "Coming later".
  - AC-030.2: THE SYSTEM SHALL settle the rinse bets by after photo or one tap and `rain_fill` by one tap (a photo is accepted and pays ×1.0 like any photo), with no before photo or inspector step for these chores. The judge SHALL count "Dirtier than before" (dusty rain) as a loss: a "Still dirty", "Dirtier than before" or "Still low" tap with a `win` verdict is invalid (one retry), and `harmful_loss` is invalid for these chores. The slip shows the loss range without the harmful loss.
  - AC-030.3: THE SYSTEM SHALL keep these chores out of the backtest, the fine-tune dataset and the Score calibration (AC-020.2): the backtest, `sib dataset` and the calibration charts of T-019 and T-014 cover the chores of REQ-016 only, so earlier reports stay comparable; their rows live outside `config/rules.json`, whose hash stays unchanged. They still count toward points and savings.

### REQ-031: Advice cards
- Story: As a household member, I want Gemma to tell me when to clean the windows, sweep the balcony, paint outdoors or feed the lawn, so that the weather does not undo the job.
- Priority: Could
- Goals: G-2
- Acceptance criteria:
  - AC-031.1: WHILE the `adviceCards` flag is on, WHEN the person adds one of the advice chores (clean windows `windows_clean`, sweep balcony leaves `balcony_sweep`, paint or varnish outdoors `outdoor_paint`, fertilise or treat the lawn `lawn_feed`) THE SYSTEM SHALL ask Gemma's advisor job, which calls `get_forecast` (up to 72 h), for one of "do it now", "wait for <window>" or "no good window in the next 72 h", with a reason ≤ 140 chars; the card shows the `tool_result` numbers for the window; WHILE the flag is off these chores are "Coming later".
  - AC-031.2: THE SYSTEM SHALL compute a rule advice for every advice card (design.md, Advice rules), show Gemma's advice with the rule advice beside it when the advice differs or the window starts differ by ≥ 3 h, and refuse (and retry once) a Gemma window that the forecast contradicts (for example a paint window with forecast rain); with Gemma offline or still refused the card shows the rule advice labelled "Rule advice".
  - AC-031.3: THE SYSTEM SHALL keep advice cards out of points, savings and calibration (advice only, no bet, no time counted), log every advisor decision in `gemma_decisions`, and offer the "How Gemma decided" disclosure (AC-028.4) on the card.
  - AC-031.4: THE SYSTEM SHALL run the safety backstop and the safety guard on advice cards as on every card; an alert replaces the advice.

### REQ-032: Optional hosted mode on DigitalOcean
- Story: As the builder, I want to run the app for my own household on a small public server with Gemma from DigitalOcean's Serverless Inference, so that I can use it away from home without a GPU, while home mode stays the default and keeps its promise.
- Priority: Could
- Goals: G-3
- Acceptance criteria:
  - AC-032.1: THE SYSTEM SHALL run in home mode unless `SIB_MODE=hosted` is set, and refuse any other `SIB_MODE` value. Home mode is unchanged (Ollama on 127.0.0.1, LAN pairing, "Your photos never leave it"); WHEN a hosted-mode variable is set in home mode THE SYSTEM SHALL log one warning naming each such variable and otherwise ignore it.
  - AC-032.2: WHILE in hosted mode THE SYSTEM SHALL refuse to start unless `SIB_PUBLIC_ORIGIN` is an `https://` origin, `SIB_DO_MODEL` is a Gemma 4 model ID listed in ADR-0011, and `SIB_DO_INFERENCE_KEY` is set. The key is an inference-only model access key read from the environment only; it is never logged, stored, returned or committed, and upstream error bodies are stripped of the key and of prompt text before logging. Gemma is called only through DigitalOcean's OpenAI-compatible inference API at the allowlisted host; every other outbound host stays refused except Open-Meteo. The status line shows the model ID.
  - AC-032.3: WHILE in hosted mode THE SYSTEM SHALL keep the access model with no accounts, hardened for a public server:
    - the server creates no pairing token at start; `sib pair` (run with `docker compose exec`) prints `<SIB_PUBLIC_ORIGIN>/pair#t=<token>` to the terminal only, never to the server log;
    - `GET /pair` returns a page with a "Pair this phone" button that POSTs the token from the URL fragment (Origin-checked), so link-preview bots and access logs never see or spend it; every response sends `Referrer-Policy: no-referrer`;
    - the session cookie is `__Host-`prefixed, `Secure`, `HttpOnly`, `SameSite=Strict`, and lasts 7 days (home mode keeps 30 days); `sib forget-devices` ends every session;
    - the Host and Origin allowlists are exactly the host and origin of `SIB_PUBLIC_ORIGIN` (`config.allowedHosts`/`publicOrigins` and LAN interfaces are ignored);
    - the client address used by every rate limit is the `X-Forwarded-For` value set by Caddy, trusted only from the Compose network; the pairing POST is rate-limited per address like the existing failure limiter.
  - AC-032.4: WHILE in hosted mode THE SYSTEM SHALL send photos to the model only if `SIB_DO_VISION=1`. With it off (the default), photo upload is refused with 409, photo blocks are hidden, the inspector does not run and bets settle by tap at ×0.5, so no bet pays ×1.0. Voice and the fine-tuned bookmaker are off in hosted mode.
  - AC-032.5: WHILE in hosted mode THE SYSTEM SHALL cap model calls per Madrid day at `SIB_DAILY_MODEL_CALLS` (default 300):
    - a call is one chat-completions request to the inference API, retries and tool rounds included; the status check uses `GET /v1/models` and is not counted;
    - the counter is stored in SQLite per Madrid date and survives restarts;
    - from 80 % of the cap, card, listener, advisor and planner jobs keep rule odds or rule advice and show "Gemma's daily limit · rule odds"; the last 20 % is reserved for judge verdicts; at the cap the judge waits like Gemma offline (AC-008.8), and retries over the cap are not sent;
    - after the Madrid-day reset, waiting verdicts run first;
    - the cap and the count are logged, never content.
  - AC-032.6: WHILE in hosted mode THE SYSTEM SHALL say where Gemma runs: the status line reads "Gemma 4 · DigitalOcean · <model ID>", and the privacy line reads "Gemma runs on DigitalOcean's inference service. Your chores, habits, answers and area forecast are sent there. Photos are off." With `SIB_DO_VISION=1` it reads "Gemma runs on DigitalOcean's inference service. Your chores, habits, answers, area forecast and the photos you add are sent there." The README and `docs/deploy-digitalocean.md` state the same trade-off.
  - AC-032.7: WHILE in hosted mode THE SYSTEM SHALL answer `GET /healthz` with 204 and no body without a session only for requests from 127.0.0.1 inside the container (the container health check); Caddy returns 404 for `/healthz` from outside.
  - AC-032.8: WHEN the builder runs `sib hosted-check` THE SYSTEM SHALL call the inference API once per check and report, without household data: the model is listed by `/v1/models`, a JSON answer validates, a tool call comes back (else "use injected tool use"), and an image is accepted (else "keep SIB_DO_VISION off"). The results are recorded in ADR-0011 by the builder.

## Non-functional requirements
| ID | Category | Requirement (measurable) | Verification |
|---|---|---|---|
| NFR-001 | Security | In home mode the app server binds only to 127.0.0.1 and the home-LAN interface (hosted mode: NFR-013); the model runtime binds only to 127.0.0.1. All routes require a session (REQ-001). Token ≥ 128 bits CSPRNG, constant-time comparison, ≤ 3 devices per token; Host allowlist (AC-001.9). 0 high/critical findings in `npm audit --audit-level=high`; gitleaks clean. Known limit (plain HTTP cookie sniffing on the LAN) documented in README with the Tailscale Serve option. | Integration tests for 401/403/rate limit; `ss -ltnp` check during setup; CI audit and gitleaks |
| NFR-002 | Privacy / data classification | Photos, chore text, habits and audio are **household-private**: stored only in the git-ignored data folder, never sent off the laptop in home mode (the default). The optional hosted mode (REQ-032) sends chore text, habits and forecasts to DigitalOcean's inference API, and photos only with `SIB_DO_VISION=1`; it says so on screen and in the docs (AC-032.6). Committed test fixtures are recorded only from staged or synthetic inputs and reviewed by hand. In home mode the only outbound host at runtime is Open-Meteo, with coordinates rounded to 2 decimals; a place search typed in onboarding (AC-024.4) is the one text that leaves the laptop, sent only to Open-Meteo geocoding when the person searches. 0 analytics or telemetry. Photos EXIF-stripped and ≤ 1024 px. | Test that stored photos have no EXIF; CI test that the weather client refuses non-allowlisted hosts (AC-014.7); network capture during one capture → settle cycle shows only Open-Meteo hosts |
| NFR-003 | Reliability | 100% of open bets and their settle times survive a server or laptop restart, and every schema migration keeps existing rows (tested on a copy of the live database before it is applied). With Open-Meteo down, odds use the cached forecast (REQ-014); with Gemma down, odds fall back to the rule and settlements wait (REQ-013, AC-008.8). SQLite writes are transactional. | Restart test with open bets; fault-injection tests for weather and Gemma offline |
| NFR-004 | Performance | Rule odds on a new card ≤ 1 s (AC-004.1). Photo judgement (inspector + bookmaker, incl. the tool call) ≤ 15 s in ≥ 19 of 20 tries on the builder's laptop; each model call times out at 30 s and each Gemma job at 45 s. Schema-valid JSON ≥ 19 of 20 per job. App screens interactive ≤ 3 s on the phone over home Wi-Fi. | T-001 spike measurements, re-run before the freeze; logged latencies (NFR-007) |
| NFR-005 | Scale | Sized for 1 household, ≤ 3 paired devices per pairing token (enforced, AC-001.2), ≤ 100 bets/week (not enforced). Backtest (Apr–Oct 2026, the REQ-016 chores, E4B + E2B; the fine-tuned model is evaluated on the hold-out in AC-019.3) completes in ≤ 8 h on the laptop, resumable, paused from 07:00 so morning settlements get the GPU. | Backtest run time and call-count estimate in T-015 |
| NFR-006 | Cost | Home mode: 0 € running cost; hosted mode (REQ-032): about 7–13 US$ a month (a 1 GiB Droplet with daily backups plus per-token Gemma inference at the expected volume; estimates and sources in ADR-0011 and `docs/deploy-digitalocean.md`), held below 20 US$ a month by the daily call cap and a model access key budget; Open-Meteo ≤ 1,000 calls/day (limit 10,000); fine-tune on the laptop GPU, Colab free tier as fallback. | Call counter in logs |
| NFR-007 | Observability | Local structured JSON logs; every Gemma call logs job, model version, prompt version, latency, schema-valid flag and retries; never tokens, session IDs or photo bytes. Gemma status visible in the UI (AC-013.5). | Log inspection test |
| NFR-008 | Compliance / licensing | Repo MIT; README lists third-party licences (Gemma 4 Apache 2.0, Open-Meteo CC BY 4.0 non-commercial, fonts SIL OFL, Lucide ISC). Points only: no stakes, purchases or value. Challenge rules (repo window, public, tags) met. | Release checklist before publishing |
| NFR-009 | Accessibility | WCAG 2.2 AA on all mobile screens: text contrast ≥ 4.5:1 (use `ink-3-text`, `amber-text` tokens), touch targets ≥ 44 × 44 px, win/lose never by colour alone, odds always with words, `prefers-reduced-motion` respected. | `ux-reviewer` pass; automated contrast check on tokens |
| NFR-010 | Testability | Every Gemma job runs against a fake returning recorded JSON fixtures; CI runs with no GPU, no model and no network. The fake model runs only when `SIB_FAKE_MODEL=1` is set, and `sib start` refuses to start without a configured Gemma tag, so fixtures never pose as Gemma, except in `sib demo` (AC-029.4), whose rows carry `model_version = 'fake-demo'`, are labelled "Sample data · fake model" and live in a temporary folder; `SIB_FAKE_WEATHER=1` swaps in fake weather for development. Points, rule baseline, settlement and savings logic have unit tests covering every AC above. | CI green without GPU or network |
| NFR-011 | Portability / setup | Supported: Windows 11 + WSL2 (Ubuntu), NVIDIA GPU ≥ 8 GB VRAM, ≥ 16 GB RAM [ASSUMPTION A-11], Node.js 24 (pinned); phone: current iOS Safari or Android Chrome. Model pinned by tag and digest. From a clean clone, setup (excluding model download) ≤ 30 min following the README. | Fresh-clone run-through before publishing |
| NFR-012 | Reproducibility | Backtest and fine-tune evaluation are reproducible: pinned model digests, fixed seeds, fixed date split, weather data snapshot saved with attribution; re-running gives the same reported numbers. | Re-run from the snapshot matches the report |
| NFR-013 | Security / operations (hosted mode, REQ-032) | Hosted mode runs as a non-root container with a read-only root filesystem (a tmpfs `/tmp`), all capabilities dropped and no-new-privileges, behind Caddy with automatic HTTPS (Let's Encrypt) and HSTS, access logs off; only ports 80 and 443 are public and SSH (22) is open only to the builder's IP via a DigitalOcean Cloud Firewall; SSH by key only. Data (SQLite + photos) lives on the Droplet disk under `/srv/sib/data` (owner-only), covered by daily Droplet backups; a nightly online copy (`VACUUM INTO` plus the photos) is kept 7 days in an owner-only folder and is household-private data, like the backups; the builder can copy it off the server with `scp`. Encryption at rest is DigitalOcean's (stated in ADR-0011 as verified or unverified). Secrets come from a root-owned env file outside git (mode 0600). The app restarts on failure, the container checks `/healthz` (AC-032.7), SIGTERM shuts down cleanly. Infrastructure is Terraform in `infra/digitalocean/` with local, git-ignored state (`*.tfstate*`, `.terraform/`), the token only from `DIGITALOCEAN_TOKEN`; the builder runs plan and apply. Target: 0 high/critical findings in `npm audit`, the container review and the security review. | Security and iac reviews of T-040/T-041, the `docs/deploy-digitalocean.md` checklist |

## Out of scope
- Push notifications and service workers: need HTTPS; polling while the app is open is enough for one household (closes Q-6).
- Browser Web Speech API for voice: sends audio to Google, breaking G-5.
- Cloudflare quick tunnels: public, and route home photos through a third party; Tailscale Serve is the HTTPS fallback.
- Everything listed under Non-goals in [product.md](product.md#non-goals-explicitly-out-of-scope).

## Open questions (requirements)
- [x] Q-12: Source of "recorded weather" at settle time: the forecast API's past hours, labelled "modelled recent weather"; the backtest uses the archive (answered 2026-10-21, ADR-0008).

## Assumptions (requirements)
- A-9: Undo is available for 5 minutes after placing; after that the bet is locked (stops undoing bets that are going badly). Cash-out applies only when REQ-022 is enabled.
- A-10: Without a forecast younger than 24 h, no new bets are allowed (odds would be meaningless); existing bets are unaffected.
- A-11: The builder's laptop has ≥ 16 GB RAM (VRAM 8 GB+ confirmed).
