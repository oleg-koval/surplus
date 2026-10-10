import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLaunchDebit, recordLaunchDebit } from '../src/core/debit.js';
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

/** Launches once against the sample, mirroring prepare() then onStarted(); returns the decision and the new debit. */
const launch = (usage: UsageSnapshot, debit: LaunchDebit | undefined, perLaunch = 1): { remaining: number | null; tier: string; debit: LaunchDebit | undefined } => {
  const decision = decide({ usage: applyLaunchDebit(usage, debit), config, now });
  return { remaining: decision.weeklyRemainingPercent, tier: decision.tier, debit: decision.tier === 'premium' ? recordLaunchDebit(usage, debit, perLaunch) : debit };
};

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

  it('clamps the adjusted used percent at 100', () => {
    const adjusted = applyLaunchDebit({ ...sample, weeklyUsedPercent: 99.5 }, { resetsAt: sample.resetsAt, observedAt: sample.observedAt, identityHash: 'account-a', percent: 5 });
    expect(adjusted.weeklyUsedPercent).toBe(100);
  });

  it('is cleared by a newer sample', () => {
    const debit = recordLaunchDebit(sample, undefined, 3);
    const newer = { ...sample, observedAt: new Date(now.getTime() + 60_000).toISOString() };
    expect(applyLaunchDebit(newer, debit)).toBe(newer);
    expect(recordLaunchDebit(newer, debit, 1)?.percent).toBe(1);
  });

  it('is cleared by a reset rollover', () => {
    const debit = recordLaunchDebit(sample, undefined, 3);
    const rolled = { ...sample, resetsAt: new Date(now.getTime() + 8 * 24 * 60 * 60_000).toISOString() };
    expect(applyLaunchDebit(rolled, debit)).toBe(rolled);
  });

  it('is cleared by a Claude identity change', () => {
    const debit = recordLaunchDebit(sample, undefined, 3);
    const other = { ...sample, identityHash: 'account-b' };
    expect(applyLaunchDebit(other, debit)).toBe(other);
    expect(applyLaunchDebit({ ...sample, identityHash: undefined }, debit).weeklyUsedPercent).toBe(60);
  });

  it('records nothing when the per-launch amount is 0', () => {
    expect(recordLaunchDebit(sample, undefined, 0)).toBeUndefined();
    expect(applyLaunchDebit(sample, { resetsAt: sample.resetsAt, observedAt: sample.observedAt, identityHash: 'account-a', percent: 0 })).toBe(sample);
    const step = launch(sample, undefined, 0);
    expect(step.debit).toBeUndefined();
    expect(launch(sample, step.debit, 0).remaining).toBe(step.remaining);
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
