# Design handoff: Should I Bother? — The Lazy Bookie

- Last updated: 2026-10-20
- Source of truth: Figma file https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z (page "Should I Bother?").
- Exports: `images/*.png` (1× renders, 393 px wide for mobile). After `new-project`, copy them to `docs/images/` (the folder the `ui-designer` agent and `ux-review` skill read). Copy `design/` (tokens) to `docs/design/`.
- Scope: **mobile-first web app** (393 × 852 frame, iPhone 15/16 size). Desktop frames D1/D2 are reference only and out of MVP scope.
- Rule for implementers: where this file, `product-concept.md` and the mockups disagree, the spec (`docs/spec/`) wins, then `product-concept.md`, then the mockups. Known mismatches are listed in §6.

## 1. Screens
Links open the frame in Figma (`node-id` uses `-` instead of `:`).

| # | Screen | Image | Figma | Purpose | Key elements |
|---|---|---|---|---|---|
| 01 | Onboarding | `images/01-onboarding.png` | [2:30](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=2-30) | Set up what's outside, location, privacy | Split-flap "Today's card" race board; "Let the sky do your chores."; outdoor tiles (multi-select cards with check); location row with Change; privacy note; primary "Start lazing" |
| 02 | Today | `images/02-today.png` | [2:165](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=2-165) | Turn chores into bets | Greeting + points/rank chip; "This week the sky did" savings strip (time back, water, electricity); weather board (split-flap temperature, condition, rain/wind, hourly "lazy" bars, lazy window tag); capture bar (text + camera + mic); quick chips; "Today's slips": laundry planner card, bet slip, "Add photo · better odds" hint, no-bet card |
| 03 | Voice capture | `images/03-voice-capture.png` | [2:395](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=2-395) | One sentence → many cards | Bottom sheet over Today; "Listening · Gemma on device"; waveform; live transcript with weather chores highlighted green and non-weather grey; parsed list with odds labels ("Likely · 85%", "Risky · 35%", "No rain, no bet", "Not a weather chore"); primary "See odds for 3 chores" |
| 04 | Place a bet | `images/04-place-a-bet.png` | [2:478](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=2-478) | Commit with full information | Sheet; chore header (icon, name, item + place); user photo with timestamp; "What Gemma saw" checklist; odds meter with before → after ("35% → 55%", "The photo raised your odds by 20 points"); payout table (weather does it +45 / you have to water −50 / basil wilts −150); settle time + rescue note; primary "Place bet · do nothing", secondary "Water it" |
| 05 | Slips | `images/05-slips.png` | [3:225](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=3-225) | Track and settle | Segmented control (Settle now · Waiting · Settled); highlighted settle card with recorded weather chips and "Is it dry?" Yes, dry / Damp / Wet + "Add an after photo for full points"; waiting bets with progress ring, hours left, alert status and "Cash out −10"; settled list with PAID stamp and +/− points |
| 06 | Settle a bet | `images/06-settle-a-bet.png` | [3:389](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=3-389) | Close a bet with evidence | Before and after photos with times; recorded weather chips; "Gemma's read of the after photo"; "Your call: is it dry?" radio list with points per answer; note on photo proof and appeal; primary "Stamp it · +15" |
| 07 | You won | `images/07-you-won.png` | [3:482](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=3-482) | The payoff moment | Sloth mascot; payout receipt (bet, odds, proof, weather, time saved, water saved); red PAID OUT stamp; big "+65"; barcode; achievement unlocked; "Back to lazing", "Share this slip" |
| 08 | Score | `images/08-score.png` | [3:544](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=3-544) | The Lazy Payoff | Rank card (rank n of 4, points, progress to next rank, mascot); stat tiles (chores skipped, water, energy, net time back) with net-time note; "How honest is Gemma?" calibration bars (predicted vs what happened); achievements row; tab bar |
| — | Components & foundations | `images/00-components-and-foundations.png` | [1:22](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=1-22) | Library | Palette, type specimen, buttons, chips, stat tile, bet slip, tab bar, icons, laundry planner variants |
| D1 | Desktop · Today | `images/d1-desktop-today.png` | [8:375](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=8-375) | Reference only | Sidebar nav, two-column Today with settle card, rank card and stats |
| D2 | Desktop · Place a bet | `images/d2-desktop-place-a-bet.png` | [8:755](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=8-755) | Reference only | Place-a-bet as a centred modal |

Prototype flow in Figma: "Mobile flow" starts at 01 Onboarding; "Desktop flow" at D1.

## 2. Components
| Component | Figma | Properties | Notes |
|---|---|---|---|
| Button | [1:152](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=1-152) (set) | `Style`: Primary · Secondary · Sun · Ghost; `Label` text | Primary = ink fill, sun text, 3 px sun bottom bar; Secondary = card fill, ink border (~1.5 px); Sun = sun fill, ink text; Ghost = text only. One primary per screen. |
| Chip | [1:153](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=1-153) | `Label` text, `Icon` swap | Quick-add chore chips (mono caps, outlined) |
| Stat tile | [1:158](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=1-158) | `Value`, `Label`, `Icon` swap | 170 × 115; display-font value |
| Bet slip | [1:164](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=1-164) | `Chore`, `Settles`, `Odds`, `Likelihood`, `Reason`, `Win`, `Lose`, `Number`, `Saves`, `Icon` swap, `Show actions` (bool) | Receipt style: "Lazy Bookie · Bet slip · Nº 0412" header, dashed rules, perforation notches, torn bottom edge; odds in sun on ink tile; win tag sun-soft |
| Laundry planner | [20:1006](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=20-1006) (set) | `State`: Wash today · Skip today · No good day | 4-day drying strip (day, icon, %, label), best day inverted; Wash today = ADVICE, primary "Wash today · +5", secondary "Remind 10:00"; Skip today = BET, "Need anything washed before Thursday?" with "No, wait" / "Yes, wash today"; No good day = no bet, "Got it" |
| Tab bar | [1:192](https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z?node-id=1-192) | — | Today · Slips · (mic, raised sun button) · Score · Chores; active item in sun/leaf. Make it ≥ 56 px tall plus safe-area inset (the component is 40 px). |
| Icons | `Icon/*` 1:28…1:143 | 24 px, 1.8 px round stroke | sun, rain, shirt, plant, car, wind, camera, mic, check, clock, trophy, ticket, bed, drop, bolt, alert, plus, sparkle, thermo, arrow, pin, x, window, home, lock. The Figma SVG export of these is broken (clipped viewBox); use **Lucide** (ISC) with `stroke-width="1.8"`: Sun, CloudRain, Shirt, Sprout, Car, Wind, Camera, Mic, Check, Clock, Trophy, Ticket, BedDouble, Droplet, Zap, TriangleAlert, Plus, Sparkles, Thermometer, ArrowRight, MapPin, X, AppWindow, House, Lock. |

Patterns without a component yet (build as components): split-flap tile and board, weather board with hourly bars, odds meter, payout table, progress ring, segmented control, outdoor option tile, PAID stamp, receipt torn edge, before/after photo pair, calibration chart, achievement badge, bottom sheet.

## 3. Foundations
Machine-readable tokens: `design/design-tokens.json` and `design/tokens.css` (CSS custom properties).

### Colour (Figma variable collection "Lazy Bookie")
| Token | Hex | Use |
|---|---|---|
| ink | #1C1C1A | Text, primary buttons, dark boards |
| ink-2 | #4A4740 | Body text on paper/card |
| ink-3 | #86826F | Captions, inactive (see contrast note) |
| paper | #E9E5D8 | App background |
| card | #F8F6EF | Cards, slips, sheets |
| line | #CBC6B4 | Rules, borders |
| leaf / leaf-soft | #1E5B3A / #DCE6D3 | Positive values, selected tiles, "advice" |
| sun / sun-soft | #FFC23A / #F8E7B5 | Odds, wins, primary-button text, highlights |
| rain / rain-soft | #7FA6C9 / #DCE4EC | Rain visuals (decorative only) |
| coral / coral-soft | #C8322B / #F2D6CF | PAID stamp, harmful loss, cash-out, alerts |
| amber / amber-soft | #9A6200 / #F1E0B4 | Normal loss, "risky" odds |
| sky-deep / sky-mid | #14243A / #2C4A6B | Night/weather gradients |
| bark | #9A8572 | Mascot branch, illustration |

### Type
| Role | Font | Weights | Typical sizes (px) |
|---|---|---|---|
| Display (headlines, chore names, big numbers) | Big Shoulders Display | Black 900, ExtraBold 800 | 22, 26, 30, 34–35; hero numbers larger; uppercase |
| Mono (odds, receipts, labels, tags) | IBM Plex Mono | Medium 500, SemiBold 600 | 9–12.5 for labels (uppercase, tracked), 16–24 for figures |
| Body (sentences, buttons) | Figtree | Regular 400, SemiBold 600, Bold 700 | 13–15.5 body, 15–16 bold buttons |

All three are on Google Fonts (SIL OFL). The foundations frame header and the desktop frames still use **Bricolage Grotesque** and **DM Mono** from an earlier direction: ignore them; use the three fonts above everywhere.

### Shape, space, elevation
- Radii: 4, 8, 12, 14, 24 (sheets and phone-style cards), 999 (pills). Receipts use straight corners with notch cut-outs.
- Spacing (measured from the mockups): 4-px base; screen side gutter 20 px; card padding 16–18 px; gap between slips 16 px.
- Borders: 1 px line; secondary buttons 1.5 px ink; dashed 1 px rules inside receipts.
- Elevation: flat; no drop shadows (paper look). The primary button's 3 px sun underline is its "lift".

### Motion (proposed; not prototyped in Figma)
- PAID OUT stamp: lands from scale 1.6 → 1 with a −8° rotation, 220–280 ms ease-out, slight overshoot; the one animation worth perfecting for the demo.
- Split-flap digits flip on change (≤ 300 ms per tile).
- Respect `prefers-reduced-motion`: no flip or stamp motion, just a fade.

## 4. Accessibility checks (WCAG 2.2 AA)
Contrast computed from the tokens:

| Pair | Ratio | Result |
|---|---|---|
| ink on paper | 13.54 | Pass |
| ink-2 on card / paper | 8.57 / 7.35 | Pass |
| ink-3 on card / paper | 3.57 / 3.07 | **Fails** for text under 18.66 px bold / 24 px |
| leaf on card | 7.43 | Pass |
| coral on card | 4.92 | Pass |
| amber on card / paper | 4.71 / 4.04 | Pass on card; **fails on paper** |
| sun on ink | 10.59 | Pass |
| rain on card | 2.37 | Decorative only, never text |

Fixes to apply in code (and back in Figma later): add `ink-3-text` **#6B6757** (4.50 on paper, 5.24 on card) for small captions; add `amber-text` **#8A5700** (4.84 on paper) for amber text on paper. Never use colour alone for win/lose: keep the +/− sign and the words. Touch targets ≥ 44 × 44 px (the Damp/Wet buttons and tab bar need checking). Odds always come with plain words ("Likely", "Risky").

## 5. States to design or define in the spec
The mockups show the happy path only. The spec should define, and `ui-designer` should build:
- **Empty**: Today with no chores yet; Slips with nothing to settle / nothing waiting; Score before the first bet (rank 0, no calibration yet).
- **Loading**: "Gemma is thinking" on cards — show forecast-only odds first, then update when the photo is judged (UX rule 1: never block).
- **Errors / offline**: weather API unreachable (use last forecast, say how old); model not running on the laptop; photo too dark/unclear → Gemma says "unsure" and asks a yes/no question.
- **Safety alert card** ("Do it now", coral, no bet) — not designed yet.
- **Rescue alert** with cash-out (shown only as a line in Slips) — needs its own card/sheet.
- **Onboarding baseline questions** (dryer type, how you wash the car, AC/heater use) — not designed yet.
- **Appeal flow** (one appeal per bet with a new photo) — not designed.
- **Chores tab** (catalogue / settings) — in the tab bar but no screen.
- **"I'll do it" outcome** (+5 / −10 wasted effort) and **advice followed** (+5) results.

## 6. Known mismatches with the concept (fix in the build)
| Where | Mockup says | Concept says | Do |
|---|---|---|---|
| 01 Onboarding, 02 Today chips, 05 Slips, D1 | "Bedding to air" / "Bedding" bets (80%, +20, +30) | Airing bedding was removed | Replace with **Cooling / skip the AC** (and Heating) for the MVP |
| 01 Onboarding tiles | "Windows · Wait for rain", "Floor to sweep · Let wind do it", "Car on the street" | Windows and sweeping are advice only; car is out of the MVP | Tiles for MVP: Balcony plants, Laundry line, AC, Heater; others "coming later" or hidden |
| 01 Onboarding privacy note | "Gemma runs on this phone" | Gemma runs on the laptop; the phone is a browser | "Gemma runs on your computer at home. Your photos and voice never leave it." |
| 03 Voice capture | "Gemma on device" | Same meaning; fine | Keep |
| Foundations header, D1/D2 | Bricolage Grotesque, DM Mono | Big Shoulders Display, IBM Plex Mono, Figtree | Use the concept fonts |
| All numbers | 1,240 points, 214 L, 38 kWh, 6 h 40, 2 h 10, etc. | Sample data | Replace with real computed values; seed demo data separately |

## 7. Content and voice
Plain, specific, a little funny. Verdict first, details on tap. Numbers always carry a unit and, for savings, the assumption ("vs a wet-day dryer"). Bookie vocabulary: slip, odds, settle, cash out, paid out, stamp. Never shame the user for doing a chore.
