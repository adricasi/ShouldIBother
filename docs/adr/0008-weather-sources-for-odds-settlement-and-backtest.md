# 0008. Weather sources for odds, settlement and the backtest

- Status: Proposed (confirmed by the T-001 spike)
- Date: 2026-10-21
- Deciders: adricasi

## Context
Live odds need a forecast; live settlement the next morning needs weather for the past hours; the backtest must decide on forecasts as known at the time and settle on what happened (no lookahead). Open-Meteo's reanalysis archive lags by days. See REQ-008, REQ-014, REQ-018, Q-12.

## Options considered
1. **Settle live bets from the forecast API's past hours (model analysis) and the backtest from the archive.** Pros: live bets settle within an hour of their settle time; the backtest uses the most "recorded" data. Cons: live "recorded weather" is modelled, not measured.
2. **Wait for the archive for every settlement.** Pros: one source. Cons: bets settle days late; breaks the live week.
3. **A personal weather station or AEMET station data.** Pros: measured. Cons: new integration and hardware; not in the time budget.

## Decision
We will use Open-Meteo throughout: the Forecast API for odds; the Forecast API's past hours, labelled "modelled recent weather", for live settlement (the user's photo or tap is the real outcome); the **Previous Runs API at day-1 lead** for backtest decisions, so every decision uses a model run that started before the decision time; and the Historical Weather (archive) API, through the per-chore outcome labels in design.md, for backtest outcomes. The archive lags by days, so the Sep–Oct hold-out ends at the archive's last day when the snapshot is taken, recorded in the dataset manifest. The weather client only calls these four Open-Meteo hosts (AC-014.7). The Historical Forecast API stitches the first hours of each run into one series, which is close to what happened, so it is only a fallback, labelled "short-lead forecast (optimistic)"; if only recorded weather exists for a variable, results are labelled "perfect-forecast upper bound". T-001 confirms which variables Previous Runs offers for Gràcia from April 2026.

## Consequences
- Positive: one provider, no key, free for non-commercial use; no lookahead in the backtest.
- Negative / risks: modelled recent weather can miss a local shower; the judge weighs the user's evidence over the weather, and the post says so.
- Follow-ups: T-001 checks the variables available in each API for Gràcia; attribution (CC BY 4.0) shown in the app and README.
