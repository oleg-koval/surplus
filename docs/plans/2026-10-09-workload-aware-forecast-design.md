# Workload-Aware Forecasting for Premium Routing

**Issue:** [#10](https://github.com/oleg-koval/surplus/issues/10)
**Status:** Design approved; implementation not started

## Problem statement

Surplus currently routes premium settings using observed allowance pace. It projects weekly burn through reset from the weekly average and, when enough samples exist, the faster recent-24-hour rate. It then applies the provider premium-burn multiplier and existing reserve/headroom guards.

This is safe, but it cannot account for unusually heavy work that is still planned for the remainder of the reset window. Pace alone may leave allowance unused or route into stronger settings without reserving enough capacity for known upcoming work.

## Recommended direction

Extend the existing `expectedUsageUntilResetPercent` safety budget with a reset-scoped explicit forecast. Do not add a second reservation subsystem or a new routing strategy in v1.

The user declares expected usage before the current provider reset, for example:

```text
surplus forecast claude 20
surplus forecast claude status
surplus forecast claude clear
```

The forecast is local, provider-specific, and bound to the exact `resetAt` value. It is a safety budget, not a promise that usage can be predicted precisely.

### Policy semantics

The existing policy remains the default. The effective expected-usage budget becomes:

```text
effectiveExpectedUsage = max(
  configuredDefaultExpectedUsage,
  currentResetForecast ?? 0
)

requiredHeadroom = reservePercent + effectiveExpectedUsage
```

A forecast can therefore make routing more conservative, but cannot weaken the configured baseline. Pace projection, premium-burn multiplier, session-window checks, telemetry checks, and hysteresis remain unchanged.

## Data and command flow

1. Parse `surplus forecast <provider> <percent>`.
2. Validate the provider and a percentage in `0..100`.
3. Read the latest cached provider snapshot to obtain the current reset window.
4. If no valid reset window is available, refuse safely and ask the user to run `surplus status <provider>` first.
5. Persist a small local record containing:
   - provider;
   - exact `resetAt`;
   - expected usage percentage;
   - source (`explicit` in v1);
   - set timestamp.
6. Apply the record only when the provider and `resetAt` match current telemetry.
7. Ignore expired, malformed, mismatched, or invalid records and fall back to current behavior.
8. `clear` is idempotent and removes only the selected provider's forecast.

No network call or model call is required to set or clear a forecast. No prompts, transcripts, project names, or source code are persisted or sent anywhere.

## User-facing status

`surplus status <provider>` should expose the active forecast and effective budget without leaking private project data:

```text
PREMIUM · opus · 41% weekly remaining · reset in 1d 8h
Pace projects 37% unused at reset.
Workload forecast: 20% expected usage before reset.
Effective expected usage: 20% · reserve: 5%.
```

A conservative rejection should explain the budget:

```text
DEFAULT · provider default · 24% weekly remaining · reset in 1d 8h
Workload forecast requires 20% plus the 5% reserve; premium headroom is not sufficient.
```

Expired records should be visible as ignored rather than silently confusing:

```text
Workload forecast: expired with the previous reset window; ignored.
```

## Future automatic adapter

The same forecast contract can later support locally generated suggestions with fields such as:

```text
source: history
confidence: low | medium | high
```

That adapter should suggest rather than silently change policy. It must remain local-only and must not require prompt analysis, repository inspection, or an external LLM.

## Testing plan

- `decide()` remains behaviorally equivalent when no forecast exists.
- A forecast below the configured baseline cannot weaken routing.
- A forecast equal to the baseline behaves identically to the current policy.
- A forecast above the baseline increases required headroom.
- Exact boundary cases are covered: just below, equal to, and just above `reserve + forecast`.
- Provider mismatch and reset rollover ignore the forecast.
- Malformed local state never prevents a normal provider launch.
- `set`, `status`, and `clear` validate provider and percentage safely.
- `clear` is idempotent.
- Status reasons expose the effective value and source.
- Automatic history suggestions remain out of v1.
- `npm run ci` passes.

## Non-goals

- Prompt, transcript, repository, or task-description analysis.
- LLM-based workload estimation.
- A task planner or weighted task database.
- Cross-provider forecasts.
- Forecasts silently carrying into a new reset window.
- Changes to provider billing or active sessions.

## Acceptance criteria

- Existing users retain pace-based behavior without configuration changes.
- A reset-scoped explicit forecast can be set, inspected, replaced, and cleared per provider.
- Forecasts cannot bypass existing reserve, headroom, telemetry, session-window, or hysteresis guards.
- Missing, stale, malformed, mismatched, or invalid forecasts safely fall back to the current policy.
- Status output explains the effective forecast and routing reason.
- Tests cover policy boundaries, persistence, reset rollover, CLI validation, and fallback behavior.
- Documentation and a deterministic demo are updated.
- `npm run ci` passes.
