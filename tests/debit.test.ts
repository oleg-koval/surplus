import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pendingDebitPercent, recordLaunchDebit, releaseLaunchDebit } from '../src/core/debit.js';
import { configPath, defaultConfig, readConfig, readLaunchDebit, updateLaunchDebit } from '../src/core/files.js';
import { decide } from '../src/core/policy.js';
import type { LaunchDebit, UsageSnapshot } from '../src/core/types.js';

const now = new Date('2026-10-07T12:00:00.000Z');
const config = defaultConfig.providers.claude;
const sample: UsageSnapshot = {
  provider: 'claude', observedAt: now.toISOString(), weeklyUsedPercent: 60, sessionWindow: 'available',
  resetsAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
  sessionUsedPercent: 20, sessionResetsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), usageAllowed: true, identityHash: 'account-a',
};

/** Launches once against the sample, mirroring the locked decide-then-record step; returns the decision and the new debit. */
const launch = (usage: UsageSnapshot, debit: LaunchDebit | undefined, perLaunch = 1): { remaining: number | null; tier: string; debit: LaunchDebit | undefined } => {
  const decision = decide({ usage, config, now, pendingDebitPercent: pendingDebitPercent(usage, debit, perLaunch) });
  return { remaining: decision.weeklyRemainingPercent, tier: decision.tier, debit: decision.tier === 'premium' ? recordLaunchDebit(usage, debit, perLaunch) : debit };
};
const debitFor = (usage: UsageSnapshot, percent: number): LaunchDebit => ({ resetsAt: usage.resetsAt, observedAt: usage.observedAt, ...(usage.identityHash ? { identityHash: usage.identityHash } : {}), percent });

describe('premium launch debit', () => {
  it('defaults to one percent for Claude', () => {
    expect(defaultConfig.providers.claude.premiumLaunchDebitPercent).toBe(1);
  });

  it('shrinks remaining weekly allowance over a burst and eventually falls back to default', () => {
    let debit: LaunchDebit | undefined;
    const remaining: number[] = [];
    let tier = 'premium';
    for (let i = 0; i < 100 && tier === 'premium'; i += 1) {
      const step = launch(sample, debit);
      tier = step.tier;
      debit = step.debit;
      if (step.remaining !== null) remaining.push(step.remaining);
    }
    expect(tier).toBe('default');
    expect(remaining.length).toBeGreaterThan(2);
    expect(remaining[0]).toBe(40);
    expect(remaining[1]).toBe(39);
    for (let i = 1; i < remaining.length; i += 1) expect(remaining[i]).toBeLessThan(remaining[i - 1] ?? 0);
  });

  it('subtracts the debit once from remaining and projected unused, without extrapolating it as a rate', () => {
    const base = decide({ usage: sample, config, now });
    const debited = decide({ usage: sample, config, now, pendingDebitPercent: 4 });
    expect(debited.weeklyRemainingPercent).toBe((base.weeklyRemainingPercent ?? 0) - 4);
    expect(debited.pace?.projectedUnusedPercent).toBeCloseTo((base.pace?.projectedUnusedPercent ?? 0) - 4, 9);
    expect(debited.pace?.runsOutBeforeResetMinutes).toBe(base.pace?.runsOutBeforeResetMinutes);
  });

  it('never lets remaining go below zero', () => {
    expect(decide({ usage: sample, config, now, pendingDebitPercent: 500 }).weeklyRemainingPercent).toBe(0);
  });

  it('is cleared by a newer sample', () => {
    const debit = recordLaunchDebit(sample, undefined, 3);
    const newer = { ...sample, observedAt: new Date(now.getTime() + 60_000).toISOString() };
    expect(pendingDebitPercent(newer, debit, 1)).toBe(0);
    expect(recordLaunchDebit(newer, debit, 1)?.percent).toBe(1);
  });

  it('is cleared by a reset rollover', () => {
    const debit = recordLaunchDebit(sample, undefined, 3);
    const rolled = { ...sample, resetsAt: new Date(now.getTime() + 8 * 24 * 60 * 60_000).toISOString() };
    expect(pendingDebitPercent(rolled, debit, 1)).toBe(0);
  });

  it('is cleared by a Claude identity change', () => {
    const debit = recordLaunchDebit(sample, undefined, 3);
    expect(pendingDebitPercent({ ...sample, identityHash: 'account-b' }, debit, 1)).toBe(0);
    expect(pendingDebitPercent({ ...sample, identityHash: undefined }, debit, 1)).toBe(0);
  });

  it('keeps a debit bound to a newer sample when an older sample records', () => {
    const newer = { ...sample, observedAt: new Date(now.getTime() + 60_000).toISOString() };
    const stored = debitFor(newer, 3);
    expect(recordLaunchDebit(sample, stored, 1)).toBe(stored);
    const nextWindow = { ...sample, resetsAt: new Date(now.getTime() + 8 * 24 * 60 * 60_000).toISOString() };
    const storedNext = debitFor(nextWindow, 2);
    expect(recordLaunchDebit(sample, storedNext, 1)).toBe(storedNext);
  });

  it('ignores a stored debit and records nothing when the per-launch amount is 0', () => {
    expect(recordLaunchDebit(sample, undefined, 0)).toBeUndefined();
    expect(pendingDebitPercent(sample, debitFor(sample, 7), 0)).toBe(0);
    const step = launch(sample, debitFor(sample, 7), 0);
    expect(step.remaining).toBe(decide({ usage: sample, config, now }).weeklyRemainingPercent);
  });

  it('releases one launch from the matching debit and leaves other samples alone', () => {
    expect(releaseLaunchDebit(sample, debitFor(sample, 3), 1)?.percent).toBe(2);
    expect(releaseLaunchDebit(sample, debitFor(sample, 1), 1)).toBeUndefined();
    const other = debitFor({ ...sample, observedAt: new Date(now.getTime() + 60_000).toISOString() }, 3);
    expect(releaseLaunchDebit(sample, other, 1)).toBe(other);
  });
});

describe('launch debit storage and config', () => {
  const homes: string[] = [];
  const saved = new Map<string, string | undefined>();
  const useTempHome = async (): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-debit-'));
    homes.push(home);
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_STATE_HOME = join(home, 'state');
    return home;
  };
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    saved.clear();
  });

  it('accumulates, persists, and clears the debit', async () => {
    await useTempHome();
    await updateLaunchDebit('claude', (latest) => recordLaunchDebit(sample, latest, 1));
    await updateLaunchDebit('claude', (latest) => recordLaunchDebit(sample, latest, 1));
    expect((await readLaunchDebit('claude'))?.percent).toBe(2);
    await updateLaunchDebit('claude', () => undefined);
    await expect(readLaunchDebit('claude')).resolves.toBeUndefined();
  });

  it('fills the default and validates the range like sibling fields', async () => {
    await useTempHome();
    const write = async (providers: unknown): Promise<void> => {
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(configPath(), JSON.stringify({ version: 1, providers }), 'utf8');
    };
    const legacy = { ...defaultConfig.providers.claude } as Record<string, unknown>;
    delete legacy.premiumLaunchDebitPercent;
    await write({ claude: legacy, codex: defaultConfig.providers.codex });
    expect((await readConfig()).providers.claude.premiumLaunchDebitPercent).toBe(1);
    await write({ claude: { ...legacy, premiumLaunchDebitPercent: 0 }, codex: defaultConfig.providers.codex });
    expect((await readConfig()).providers.claude.premiumLaunchDebitPercent).toBe(0);
    for (const bad of [-1, 101, '1']) {
      await write({ claude: { ...legacy, premiumLaunchDebitPercent: bad }, codex: defaultConfig.providers.codex });
      await expect(readConfig()).rejects.toThrow(/invalid/);
    }
  });
});
