import type { Decision, Pace, ProviderConfig, ProviderState, UsageSample, UsageSnapshot, WorkloadForecast } from './types.js';

const defaultWindowMinutes = 10_080;
const recentWindowMs = 24 * 60 * 60_000;
const minRecentSpanMs = 2 * 60 * 60_000;

/**
 * Purely returns the premium burn multiplier, margin in percentage points, and minimum elapsed minutes, using provider defaults for omitted settings.
 */
const paceSettings = (config: ProviderConfig, provider: UsageSnapshot['provider']): { readonly burn: number; readonly margin: number; readonly minElapsed: number } => ({
  burn: config.premiumBurnMultiplier ?? (provider === 'codex' ? 1.3 : 1.5),
  margin: config.paceMarginPercent ?? 10,
  minElapsed: config.minPaceElapsedMinutes ?? 1440,
});

const percent = (value: number): string => String(Math.max(0, Math.round(value)));

/**
 * Purely projects unused allowance at premium burn and, when default burn exhausts allowance early, rounded minutes before reset at exhaustion.
 * Returns undefined until elapsed time is positive, finite, and meets the configured minimum.
 * Uses the faster of average usage and same-window usage over at least two hours within the last 24 hours.
 */
const computePace = (input: {
  readonly usage: UsageSnapshot;
  readonly config: ProviderConfig;
  readonly history: readonly UsageSample[];
  readonly now: Date;
  readonly windowMinutes: number;
}): Pace | undefined => {
  const { usage, config, history, now, windowMinutes } = input;
  const { burn, minElapsed } = paceSettings(config, usage.provider);
  // Measure elapsed at observation time, so a stale-but-allowed snapshot cannot understate the burn rate.
  const observed = Date.parse(usage.observedAt);
  const elapsed = (observed - (Date.parse(usage.resetsAt) - windowMinutes * 60_000)) / 60_000;
  // Project from observation time too, so usage burned between observation and now is not left out.
  const minutesFromObservation = (Date.parse(usage.resetsAt) - observed) / 60_000;
  if (!Number.isFinite(elapsed) || elapsed < minElapsed || elapsed <= 0) return undefined;
  const avgRate = usage.weeklyUsedPercent / elapsed;
  const recent = history
    .filter((sample) => sample.resetsAt === usage.resetsAt && Number.isFinite(Date.parse(sample.observedAt))
      && now.getTime() - Date.parse(sample.observedAt) <= recentWindowMs && Date.parse(sample.observedAt) <= observed
      && sample.identityHash === usage.identityHash)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  let recentRate = 0;
  const first = recent[0];
  if (first && observed - Date.parse(first.observedAt) >= minRecentSpanMs) {
    recentRate = Math.max(0, usage.weeklyUsedPercent - first.used) / ((observed - Date.parse(first.observedAt)) / 60_000);
  }
  const rate = Math.max(avgRate, recentRate);
  const projectedUnusedPercent = 100 - (usage.weeklyUsedPercent + rate * burn * minutesFromObservation);
  const defaultUsedAtReset = usage.weeklyUsedPercent + rate * minutesFromObservation;
  const runsOut = rate > 0 && defaultUsedAtReset > 100
    ? minutesFromObservation - (100 - usage.weeklyUsedPercent) / rate : undefined;
  return {
    projectedUnusedPercent,
    ...(runsOut !== undefined && runsOut > 0 ? { runsOutBeforeResetMinutes: Math.round(runsOut) } : {}),
  };
};

/**
 * Returns a routing decision with its reason and available allowance, reset, and pace estimates, choosing default when telemetry or headroom checks fail.
 * Uses pace when available unless near-reset routing is configured, falling back to the near-reset rule otherwise; previous premium state in the same reset window relaxes thresholds.
 * Pure when now is supplied; otherwise reads the current clock, without changing routing state or launching a provider.
 */
export const decide = (input: {
  readonly usage?: UsageSnapshot;
  readonly config: ProviderConfig;
  readonly previous?: ProviderState;
  readonly history?: readonly UsageSample[];
  readonly forecast?: WorkloadForecast;
  readonly now?: Date;
}): Decision => {
  const { usage, config, previous, history = [], forecast, now = new Date() } = input;
  const fallback = (reason: string, weeklyRemainingPercent: number | null = null, minutesUntilReset: number | null = null, pace?: Pace): Decision => ({
    tier: 'default', model: 'provider default', reason, weeklyRemainingPercent, minutesUntilReset, ...(pace ? { pace } : {}),
  });

  if (!usage) return fallback('No usage telemetry is available.');
  const observed = Date.parse(usage.observedAt);
  const reset = Date.parse(usage.resetsAt);
  if (!Number.isFinite(observed) || now.getTime() - observed > config.maxTelemetryAgeMinutes * 60_000 || observed > now.getTime() + 60_000) {
    return fallback('Usage telemetry is stale or has an invalid timestamp.');
  }
  if (!Number.isFinite(reset) || reset <= now.getTime()) return fallback('The weekly reset time is missing or has passed.');
  const sessionReset = usage.sessionResetsAt ? Date.parse(usage.sessionResetsAt) : Number.NaN;
  const sessionUsed = usage.sessionUsedPercent;
  if (usage.sessionWindow === 'available' && (typeof sessionUsed !== 'number' || !Number.isFinite(sessionUsed) || sessionUsed < 0 || sessionUsed > 100 || !Number.isFinite(sessionReset) || sessionReset <= now.getTime())) {
    return fallback('Fresh session-window telemetry is unavailable.');
  }
  if (usage.usageAllowed !== true) return fallback('The provider did not confirm included usage is available.');
  if (usage.sessionWindow !== 'available' && !(usage.provider === 'codex' && usage.sessionWindow === 'absent')) return fallback('Fresh session-window telemetry is unavailable.');
  if (!Number.isFinite(usage.weeklyUsedPercent) || usage.weeklyUsedPercent < 0 || usage.weeklyUsedPercent > 100) {
    return fallback('The provider returned an invalid weekly usage percentage.');
  }
  const { windowMinutes = defaultWindowMinutes } = usage;
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return fallback('The provider returned an invalid usage window duration.');
  }

  const remaining = 100 - usage.weeklyUsedPercent;
  const sessionRemaining = typeof sessionUsed === 'number' ? 100 - sessionUsed : 100;
  const minutesUntilReset = Math.floor((reset - now.getTime()) / 60_000);
  const activeForecast = forecast?.provider === usage.provider && forecast.resetAt === usage.resetsAt
    && (usage.provider === 'codex' || (typeof usage.identityHash === 'string' && forecast.identityHash === usage.identityHash))
    && Number.isFinite(forecast.expectedUsagePercent) && forecast.expectedUsagePercent >= 0 && forecast.expectedUsagePercent <= 100
    ? forecast : undefined;
  const effectiveExpectedUsage = Math.max(config.expectedUsageUntilResetPercent, activeForecast?.expectedUsagePercent ?? 0);
  const forecastReason = activeForecast
    ? ` Workload forecast: ${percent(activeForecast.expectedUsagePercent)}% expected usage; effective expected usage: ${percent(effectiveExpectedUsage)}%; reserve: ${percent(config.reservePercent)}%.`
    : '';
  const requiredHeadroom = config.reservePercent + effectiveExpectedUsage;
  const sameWindow = previous?.resetAt === usage.resetsAt;
  const activePremium = sameWindow && previous.tier === 'premium';
  const threshold = activePremium
    ? config.minWeeklyRemainingPercent - config.hysteresisPercent
    : config.minWeeklyRemainingPercent;
  const pace = computePace({ usage, config, history, now, windowMinutes });

  if (remaining < requiredHeadroom) return fallback(`Weekly allowance cannot cover the ${activeForecast ? 'workload forecast and ' : ''}configured session budget and reserve.${forecastReason}`, remaining, minutesUntilReset, pace);
  if (usage.sessionWindow === 'available' && sessionRemaining < config.minSessionRemainingPercent) return fallback(`Session-window allowance is below the configured headroom.${forecastReason}`, remaining, minutesUntilReset, pace);
  if (remaining < threshold) return fallback(`Weekly allowance is below the premium threshold.${forecastReason}`, remaining, minutesUntilReset, pace);

  const strategy = config.strategy ?? 'pace';
  let reason: string;
  if (strategy === 'pace' && pace) {
    const margin = Math.max(0, paceSettings(config, usage.provider).margin - (activePremium ? config.hysteresisPercent : 0));
    if (pace.projectedUnusedPercent < config.reservePercent + margin) {
      return fallback(`On pace to leave only ~${percent(pace.projectedUnusedPercent)}% unused at reset; staying on default.${forecastReason}`, remaining, minutesUntilReset, pace);
    }
    reason = `On pace to leave ~${percent(pace.projectedUnusedPercent)}% unused at reset; premium fits.${forecastReason}`;
  } else {
    if (minutesUntilReset > config.nearResetMinutes) return fallback(`The weekly reset is not close enough to use the premium window.${forecastReason}`, remaining, minutesUntilReset, pace);
    reason = `${activePremium ? 'Premium mode remains within its hysteresis band.' : 'Fresh weekly headroom is available near the reset.'}${forecastReason}`;
  }

  const decision: Decision = {
    tier: 'premium', model: config.premiumModel, reason,
    weeklyRemainingPercent: remaining, minutesUntilReset, ...(pace ? { pace } : {}),
  };
  return config.premiumEffort ? { ...decision, effort: config.premiumEffort } : decision;
};
