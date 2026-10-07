import { describe, expect, it } from 'vitest';
import { decide } from '../src/core/policy.js';
import { defaultConfig } from '../src/core/files.js';
import type { ProviderState, UsageSnapshot } from '../src/core/types.js';

const now = new Date('2026-10-07T12:00:00.000Z');
const usage: UsageSnapshot = {
  provider: 'claude', observedAt: now.toISOString(), weeklyUsedPercent: 60, sessionWindow: 'available',
  resetsAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  sessionUsedPercent: 20, sessionResetsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), usageAllowed: true,
};
const config = defaultConfig.providers.claude;

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
    expect(decide({ usage: { ...usage, resetsAt: new Date(now.getTime() + 49 * 60 * 60_000).toISOString() }, config, now }).tier).toBe('default');
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
    expect(decide({ usage: atBand, config, previous, now }).tier).toBe('premium');
    expect(decide({ usage: atBand, config, previous: { ...previous, resetAt: '2026-10-06T12:00:00.000Z' }, now }).tier).toBe('default');
  });
});
