# 0005. Gemma sets odds as five bands, scored against a rule baseline

- Status: Proposed
- Date: 2026-10-21
- Deciders: adricasi

## Context
Gemma is the protagonist (G-2), but a 4B model is poor at producing calibrated probabilities. Results must be honest and measurable (G-4). See REQ-003, REQ-004, REQ-013.

## Options considered
1. **Gemma alone returns a percentage.** Pros: simplest story. Cons: uncalibrated numbers, no baseline to compare with.
2. **Rule baseline with a bounded Gemma photo adjustment (±20 points).** Pros: calibrated by construction. Cons: Gemma becomes a side act.
3. **Gemma returns one of five bands; code maps bands to fixed odds; a rule model runs alongside on every bet.** Pros: Gemma decides; bands suit what a small model ranks well; the rule gives an honest baseline; disagreement is visible. Cons: two odds per bet to store and explain.

## Decision
We will have Gemma return one of five bands (very likely · likely · toss-up · unlikely · very unlikely), mapped to 85 / 70 / 50 / 35 / 15 %, plus a reason and a settle time. The rule model computes its own band on every card. If Gemma is two or more bands from the rule, its answer must include a disagreement explanation or a yes/no question, or it is rejected. Rule odds are shown at once as provisional and are the fallback when Gemma is offline (bets stored with `odds_source = rule`). Fixed heat, frost and storm limits override both and turn the card into an alert.

## Consequences
- Positive: Gemma visibly makes the call; calibration can be reported per band for Gemma (base, fine-tuned) and the rule.
- Negative / risks: five bands are coarse; calibration bands with few bets are marked "too few to judge".
- Follow-ups: thresholds for the rule and the safety backstop are tuned on the backtest (Q-5).
