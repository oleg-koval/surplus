# Automatic busy-day headroom

Status: draft, not filed. Related: [workload-aware forecast design](../plans/2026-10-09-workload-aware-forecast-design.md).

## Problem

Surplus keeps fixed floors and has no signal for how spiky your usage is. Premium needs at least `minWeeklyRemainingPercent` (25%) of the weekly allowance left, the `reservePercent` (5%) plus `expectedUsageUntilResetPercent` (5%) covered, and a pace projection at premium burn that leaves at least the reserve plus `paceMarginPercent` (10%) unused at the reset (`src/core/files.ts` defaultConfig, `src/core/policy.ts`). A heavy day on top of those floors is covered only by whatever the floors leave.

The only way to reserve more today is a manual `surplus forecast <provider> N`, and it is weaker than it looks:

- With the defaults, `forecast 20` gives a required headroom of 5 + 20 = 25%, which equals the normal weekly floor. It adds no protection to a fresh decision. It matters only while premium is already active, where it holds the floor at 25% instead of the hysteresis-relaxed 20%. Values above 20 tighten the normal floor.
- It never changes the pace projection.
- It needs a saved usage reading for the current reset and is ignored after the reset or a Claude account change.

Two other facts make a burst of launches hard to see:

- Claude launches read the last sample a running session's statusline saved, accepted for up to 120 minutes. Several launches before the next refresh see the same number.
- The history behind the last-24h burn rate gains Claude samples only while a statusline is running (up to 300 samples per provider in the current window).

While the most recent launch in that reset window went premium, hysteresis relaxes the floors to 20% weekly and 10% projected unused. The first default launch ends the relaxation.

## Proposal

Add an automatic forecast with `source: 'history'`. The `WorkloadForecast` type and the existing forecast design already reserve that value next to `'explicit'`.

- Derive expected usage from the existing local per-provider history for the current window, for example the largest 24-hour burn observed this window, or a day-to-day variance band.
- Show it first as a suggestion in `surplus status`, with the statistic and sample count, before it affects any decision.
- When applied, use an explicit forecast if present; otherwise use the automatic history estimate. Combine the selected forecast with the configured baseline through `max()`, so it can never weaken the baseline.

## Scope

- Local only. No network access, and no inspection of prompts, repositories, or task text.
- Provider-specific and reset-scoped. Claude forecasts stay bound to the account identity.
- Expires at the reset, like the explicit forecast.
- No change to the pace projection, hysteresis, or session-window checks.

## Acceptance criteria

- With too few samples, no automatic forecast is produced and behavior is identical to today.
- The suggestion appears in `surplus status` and is labelled as automatic.
- When an explicit forecast is present, use it instead of the automatic history estimate; otherwise use the automatic estimate. Effective expected usage is `max(configured baseline, selected forecast)`, so the baseline cannot be weakened.
- An automatic forecast from one account or reset window is never applied to another.
- Disabling it in config restores today's behavior exactly.
- Policy tests cover each case above.

## Open questions

- Which statistic: maximum 24-hour burn, a percentile, or a variance band?
- How is confidence shown, and what is the minimum history before it applies?
- Is Claude's capture cadence dense enough between sessions to give a useful signal?
- Should it start as suggestion-only for a release before it changes decisions?
