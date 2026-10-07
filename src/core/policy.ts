import type { Decision, ProviderConfig, ProviderState, UsageSnapshot } from './types.js';

export const decide = (input: {
  readonly usage?: UsageSnapshot;
  readonly config: ProviderConfig;
  readonly previous?: ProviderState;
  readonly now?: Date;
}): Decision => {
  const { usage, config, previous, now = new Date() } = input;
  const fallback = (reason: string, weeklyRemainingPercent: number | null = null, minutesUntilReset: number | null = null): Decision => ({
    tier: 'default', model: 'provider default', reason, weeklyRemainingPercent, minutesUntilReset,
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
  if (typeof sessionUsed !== 'number' || !Number.isFinite(sessionUsed) || sessionUsed < 0 || sessionUsed > 100 || !Number.isFinite(sessionReset) || sessionReset <= now.getTime()) {
    return fallback('Fresh session-window telemetry is unavailable.');
  }
  if (usage.usageAllowed !== true) return fallback('The provider did not confirm included usage is available.');
  if (!Number.isFinite(usage.weeklyUsedPercent) || usage.weeklyUsedPercent < 0 || usage.weeklyUsedPercent > 100) {
    return fallback('The provider returned an invalid weekly usage percentage.');
  }

  const remaining = 100 - usage.weeklyUsedPercent;
  const sessionRemaining = 100 - sessionUsed;
  const minutesUntilReset = Math.floor((reset - now.getTime()) / 60_000);
  const requiredHeadroom = config.reservePercent + config.expectedUsageUntilResetPercent;
  const sameWindow = previous?.resetAt === usage.resetsAt;
  const activePremium = sameWindow && previous.tier === 'premium';
  const threshold = activePremium
    ? config.minWeeklyRemainingPercent - config.hysteresisPercent
    : config.minWeeklyRemainingPercent;

  if (remaining < requiredHeadroom) return fallback('Weekly allowance cannot cover the configured session budget and reserve.', remaining, minutesUntilReset);
  if (sessionRemaining < config.minSessionRemainingPercent) return fallback('Session-window allowance is below the configured headroom.', remaining, minutesUntilReset);
  if (remaining < threshold) return fallback('Weekly allowance is below the premium threshold.', remaining, minutesUntilReset);
  if (minutesUntilReset > config.nearResetMinutes) return fallback('The weekly reset is not close enough to use the premium window.', remaining, minutesUntilReset);

  const decision: Decision = {
    tier: 'premium', model: config.premiumModel,
    reason: activePremium ? 'Premium mode remains within its hysteresis band.' : 'Fresh weekly headroom is available near the reset.',
    weeklyRemainingPercent: remaining, minutesUntilReset,
  };
  return config.premiumEffort ? { ...decision, effort: config.premiumEffort } : decision;
};
