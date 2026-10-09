import { describe, expect, it } from 'vitest';
import { decide } from '../src/core/policy.js';
import { defaultConfig } from '../src/core/files.js';
import type { ProviderState, UsageSnapshot, WorkloadForecast } from '../src/core/types.js';

const now = new Date('2026-10-07T12:00:00.000Z');
const usage: UsageSnapshot = {
  provider: 'claude', observedAt: now.toISOString(), weeklyUsedPercent: 60, sessionWindow: 'available',
  resetsAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  sessionUsedPercent: 20, sessionResetsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), usageAllowed: true, identityHash: 'account-a',
};
const config = defaultConfig.providers.claude;
const nearReset = { ...config, strategy: 'near-reset' as const };

describe('weekly upgrade policy', () => {
  it('selects premium with fresh weekly and session headroom close to reset', () => {
    expect(decide({ usage, config, now }).tier).toBe('premium');
  });

  it('fails closed when usage is missing, stale, disallowed, or missing short-window telemetry', () => {
    expect(decide({ config, now }).reason).toMatch(/No usage telemetry/);
    expect(decide({ usage: { ...usage, observedAt: new Date(now.getTime() - 121 * 60_000).toISOString() }, config, now }).tier).toBe('default');
    expect(decide({ usage: { ...usage, usageAllowed: false }, config, now }).tier).toBe('default');
    const withoutSession = { provider: usage.provider, observedAt: usage.observedAt, weeklyUsedPercent: usage.weeklyUsedPercent, resetsAt: usage.resetsAt, sessionWindow: 'invalid' as const, usageAllowed: usage.usageAllowed };
    expect(decide({ usage: withoutSession, config, now }).tier).toBe('default');
  });

  it('respects the reset clock, weekly reserve, session headroom, and threshold', () => {
    expect(decide({ usage: { ...usage, resetsAt: new Date(now.getTime() + 49 * 60 * 60_000).toISOString() }, config: nearReset, now }).tier).toBe('default');
    expect(decide({ usage: { ...usage, weeklyUsedPercent: 92 }, config, now }).tier).toBe('default');
    expect(decide({ usage: { ...usage, sessionUsedPercent: 80 }, config, now }).tier).toBe('default');
    expect(decide({ usage: { ...usage, weeklyUsedPercent: 80 }, config, now }).tier).toBe('default');
  });

  it('uses Codex weekly-only data only when the backend confirms included usage and the short window is absent', () => {
    const codex = { ...usage, provider: 'codex' as const, sessionWindow: 'absent' as const, sessionUsedPercent: undefined, sessionResetsAt: undefined };
    expect(decide({ usage: codex, config: defaultConfig.providers.codex, now }).tier).toBe('premium');
    expect(decide({ usage: { ...codex, usageAllowed: null }, config: defaultConfig.providers.codex, now }).tier).toBe('default');
    expect(decide({ usage: { ...codex, sessionWindow: 'invalid' }, config: defaultConfig.providers.codex, now }).tier).toBe('default');
    expect(decide({ usage: { ...codex, provider: 'claude' }, config: defaultConfig.providers.claude, now }).tier).toBe('default');
  });

  it('keeps a prior premium decision inside the hysteresis band and resets at a new window', () => {
    const previous: ProviderState = { tier: 'premium', resetAt: usage.resetsAt, observedAt: usage.observedAt };
    const atBand = { ...usage, weeklyUsedPercent: 78 };
    expect(decide({ usage: atBand, config: nearReset, previous, now }).tier).toBe('premium');
    expect(decide({ usage: atBand, config, previous: { ...previous, resetAt: '2026-10-06T12:00:00.000Z' }, now }).tier).toBe('default');
  });
});

const day = 24 * 60 * 60_000;
const week = 7 * day;
// A snapshot `elapsedDays` into a 7-day window with `used` percent consumed.
const atElapsed = (elapsedDays: number, used: number, extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  ...usage, weeklyUsedPercent: used, resetsAt: new Date(now.getTime() + week - elapsedDays * day).toISOString(), ...extra,
});

describe('pace policy', () => {
  it.each([null, '', '10080', true, [], {}, Number.NaN, Infinity, -Infinity, 0, -1])('rejects invalid window duration %j', (windowMinutes) => {
    const malformed = { ...usage, windowMinutes } as unknown as UsageSnapshot;
    for (const settings of [config, nearReset]) {
      const decision = decide({ usage: malformed, config: settings, now });
      expect(decision.tier).toBe('default');
      expect(decision.reason).toMatch(/invalid usage window duration/);
      expect(decision.pace).toBeUndefined();
    }
  });

  it('uses the seven-day default only for an omitted window', () => {
    const implicit = decide({ usage, config, now });
    expect(decide({ usage: { ...usage, windowMinutes: undefined }, config, now })).toEqual(implicit);
    expect(decide({ usage: { ...usage, windowMinutes: 10080 }, config, now })).toEqual(implicit);
  });

  it('preserves near-reset routing at the start of a valid window', () => {
    const decision = decide({ usage: { ...usage, windowMinutes: 1440 }, config: { ...config, minPaceElapsedMinutes: 0 }, now });
    expect(decision.tier).toBe('premium');
    expect(decision.reason).toMatch(/Fresh weekly headroom/);
    expect(decision.pace).toBeUndefined();
  });

  it('falls back to the near-reset rule before enough of the window has elapsed', () => {
    const early = atElapsed(0.25, 2);
    const decision = decide({ usage: early, config, now });
    expect(decision.tier).toBe('default');
    expect(decision.reason).toMatch(/not close enough/);
    expect(decision.pace).toBeUndefined();
  });

  it('goes premium when the projected burn leaves enough unused', () => {
    const decision = decide({ usage: atElapsed(3, 20), config, now });
    expect(decision.tier).toBe('premium');
    expect(decision.reason).toMatch(/On pace to leave ~\d+% unused at reset; premium fits\./);
    expect(decision.pace?.projectedUnusedPercent).toBeGreaterThan(15);
  });

  it('stays on default and reports a run-out when the pace is too fast', () => {
    const decision = decide({ usage: atElapsed(3, 60), config, now });
    expect(decision.tier).toBe('default');
    expect(decision.reason).toMatch(/staying on default/);
    expect(decision.pace?.runsOutBeforeResetMinutes).toBeGreaterThan(0);
  });

  it('uses a lower margin while premium is already active in the same window', () => {
    // 3 days in at 29% used: projected unused is 13%, between margin 5+10=15 and the lowered 5+5=10.
    const borderline = atElapsed(3, 29);
    expect(decide({ usage: borderline, config, now }).tier).toBe('default');
    const previous: ProviderState = { tier: 'premium', resetAt: borderline.resetsAt, observedAt: borderline.observedAt };
    expect(decide({ usage: borderline, config, previous, now }).tier).toBe('premium');
    expect(decide({ usage: borderline, config, previous: { ...previous, resetAt: '2026-10-01T00:00:00.000Z' }, now }).tier).toBe('default');
  });

  it('lets a faster recent rate override a slow weekly average', () => {
    const current = atElapsed(3, 20);
    expect(decide({ usage: current, config, now }).tier).toBe('premium');
    const sample = (hoursAgo: number, resetsAt = current.resetsAt): { observedAt: string; used: number; resetsAt: string; identityHash: string } =>
      ({ observedAt: new Date(now.getTime() - hoursAgo * 60 * 60_000).toISOString(), used: 12, resetsAt, identityHash: 'account-a' });
    expect(decide({ usage: current, config, history: [sample(4)], now }).tier).toBe('default');
    // Without a span of at least two hours the recent rate is ignored.
    expect(decide({ usage: current, config, history: [sample(1)], now }).tier).toBe('premium');
    // Samples older than a day or from another window never count.
    expect(decide({ usage: current, config, history: [sample(30)], now }).tier).toBe('premium');
    expect(decide({ usage: current, config, history: [sample(4, '2026-10-01T00:00:00.000Z')], now }).tier).toBe('premium');
  });

  it('ignores history from a different identity even when the reset timestamp matches', () => {
    const current = atElapsed(3, 20, { identityHash: 'account-b' });
    const oldAccount = { observedAt: new Date(now.getTime() - 4 * 60 * 60_000).toISOString(), used: 12, resetsAt: current.resetsAt, identityHash: 'account-a' };
    expect(decide({ usage: current, config, history: [oldAccount], now }).tier).toBe('premium');
  });

  it('measures pace and minimum elapsed time from when usage was observed', () => {
    const observedEarlier = new Date(now.getTime() - 12 * 60 * 60_000);
    const stale = atElapsed(1, 20, { observedAt: observedEarlier.toISOString() });
    const decision = decide({ usage: stale, config: { ...config, maxTelemetryAgeMinutes: 24 * 60, minPaceElapsedMinutes: 2 * 60 }, now });
    const observedElapsedMinutes = 12 * 60;
    const minutesFromObservation = Math.round((Date.parse(stale.resetsAt) - observedEarlier.getTime()) / 60_000);
    expect(decision.pace?.projectedUnusedPercent).toBeCloseTo(100 - (20 + (20 / observedElapsedMinutes) * 1.5 * minutesFromObservation), 5);
  });

  it('projects from when usage was observed, so time since observation cannot overstate unused allowance', () => {
    // 27.6% used, observed 2h ago with 4d to reset: projecting over 4d leaves ~15.6% (premium), over 4d2h ~14.4% (default).
    const observedEarlier = new Date(now.getTime() - 2 * 60 * 60_000);
    const stale = atElapsed(3, 27.6, { observedAt: observedEarlier.toISOString() });
    const decision = decide({ usage: stale, config: { ...config, maxTelemetryAgeMinutes: 3 * 60 }, now });
    expect(decision.pace?.projectedUnusedPercent).toBeCloseTo(100 - 27.6 * (1 + 1.5 * (98 * 60) / (70 * 60)), 5);
    expect(decision.tier).toBe('default');
  });

  it('honours the Codex window length and burn multiplier', () => {
    const codex = { ...usage, provider: 'codex' as const, sessionWindow: 'absent' as const, sessionUsedPercent: undefined, sessionResetsAt: undefined };
    const twoDayWindow = 2 * day;
    const inWindow = { ...codex, windowMinutes: 2 * 24 * 60, weeklyUsedPercent: 30, resetsAt: new Date(now.getTime() + twoDayWindow / 2).toISOString() };
    // 1 of 2 days elapsed, 30% used -> 0.0208%/min * 1.3 * 1440 = 39 more -> 31% unused.
    expect(decide({ usage: inWindow, config: defaultConfig.providers.codex, now }).tier).toBe('premium');
    const assumedWeek = { ...inWindow, windowMinutes: undefined };
    expect(decide({ usage: assumedWeek, config: defaultConfig.providers.codex, now }).pace?.projectedUnusedPercent)
      .not.toBeCloseTo(decide({ usage: inWindow, config: defaultConfig.providers.codex, now }).pace?.projectedUnusedPercent ?? 0, 0);
    const hungry = { ...defaultConfig.providers.codex, premiumBurnMultiplier: 4 };
    expect(decide({ usage: inWindow, config: hungry, now }).tier).toBe('default');
  });

  it('uses a matching reset-scoped workload forecast as additional headroom', () => {
    const candidate = { ...usage, weeklyUsedPercent: 70 };
    const forecast: WorkloadForecast = {
      provider: 'claude', resetAt: candidate.resetsAt, expectedUsagePercent: 26, source: 'explicit', setAt: now.toISOString(), identityHash: 'account-a',
    };
    expect(decide({ usage: candidate, config: nearReset, now }).tier).toBe('premium');
    const decision = decide({ usage: candidate, config: nearReset, forecast, now });
    expect(decision.tier).toBe('default');
    expect(decision.reason).toMatch(/workload forecast/i);
    expect(decision.reason).toMatch(/effective expected usage: 26%/i);
  });

  it('does not let a low forecast weaken the configured baseline', () => {
    const candidate = { ...usage, weeklyUsedPercent: 84 };
    const guardConfig = { ...nearReset, minWeeklyRemainingPercent: 0, reservePercent: 5, expectedUsageUntilResetPercent: 20 };
    const forecast: WorkloadForecast = {
      provider: 'claude', resetAt: candidate.resetsAt, expectedUsagePercent: 0, source: 'explicit', setAt: now.toISOString(), identityHash: 'account-a',
    };
    const baseline = decide({ usage: candidate, config: guardConfig, now });
    const decision = decide({ usage: candidate, config: guardConfig, forecast, now });
    expect(baseline.tier).toBe('default');
    expect(decide({ usage: candidate, config: { ...guardConfig, expectedUsageUntilResetPercent: 0 }, now }).tier).toBe('premium');
    expect(decision.tier).toBe(baseline.tier);
    expect(decision.model).toBe(baseline.model);
    expect(decision.weeklyRemainingPercent).toBe(baseline.weeklyRemainingPercent);
    expect(decision.pace).toEqual(baseline.pace);
    expect(decision.reason).toMatch(/effective expected usage: 20%/i);
  });

  it('ignores a forecast from another provider or reset window', () => {
    const candidate = { ...usage, weeklyUsedPercent: 70 };
    const wrongProvider: WorkloadForecast = {
      provider: 'codex', resetAt: candidate.resetsAt, expectedUsagePercent: 26, source: 'explicit', setAt: now.toISOString(), identityHash: 'account-a',
    };
    const wrongReset: WorkloadForecast = {
      provider: 'claude', resetAt: '2026-10-06T12:00:00.000Z', expectedUsagePercent: 26, source: 'explicit', setAt: now.toISOString(), identityHash: 'account-a',
    };
    const baseline = decide({ usage: candidate, config: nearReset, now });
    expect(decide({ usage: candidate, config: nearReset, forecast: wrongProvider, now })).toEqual(baseline);
    expect(decide({ usage: candidate, config: nearReset, forecast: wrongReset, now })).toEqual(baseline);
  });

  it('ignores a Claude forecast bound to another account even when the reset timestamp matches', () => {
    const forecast: WorkloadForecast = {
      provider: 'claude', resetAt: usage.resetsAt, expectedUsagePercent: 80, source: 'explicit', setAt: now.toISOString(), identityHash: 'account-b',
    };
    expect(decide({ usage, config, forecast, now })).toEqual(decide({ usage, config, now }));
  });
});
