import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSegment, main } from '../src/cli.js';
import { dataDir, defaultConfig, defaultFeatures, readHookSessions, readUsageHistory, saveConfig, saveForecast, saveHookSession, saveUsage } from '../src/core/files.js';
import { hookMessage, runHook } from '../src/hook.js';
import { statuslineSegment, withSegment } from '../src/core/notice.js';
import type { UsageSnapshot } from '../src/core/types.js';
import { discoverCodex } from '../src/providers/codex.js';
import type { CodexDiscovery } from '../src/providers/codex.js';

const homes: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const setEnv = (key: string, value: string | undefined): void => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
};
const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'surplus-notices-'));
  homes.push(home);
  setEnv('HOME', home);
  setEnv('XDG_STATE_HOME', join(home, 'state'));
  setEnv('XDG_CONFIG_HOME', join(home, 'config'));
  setEnv('SURPLUS_CLAUDE_IDENTITY_HASH', 'id-1');
  setEnv('SURPLUS_ROUTED_TIER', undefined);
  await run(home);
};
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  savedEnv.clear();
});

const now = new Date('2026-10-07T12:00:00.000Z');
const day = 24 * 60 * 60_000;
const claudeUsage = (elapsedDays: number, used: number, observedAt = now): UsageSnapshot => ({
  provider: 'claude', observedAt: observedAt.toISOString(), weeklyUsedPercent: used, sessionWindow: 'available',
  resetsAt: new Date(now.getTime() + 7 * day - elapsedDays * day).toISOString(),
  sessionUsedPercent: 10, sessionResetsAt: new Date(now.getTime() + 3 * 60 * 60_000).toISOString(), usageAllowed: true, identityHash: 'id-1',
});
const premiumUsage = claudeUsage(3, 20);
const fastUsage = claudeUsage(3, 60);

describe('usage history', () => {
  it('retains only samples with valid percentages, observation dates, and field types', async () => {
    await withHome(async () => {
      await saveUsage(premiumUsage);
      const sample = { observedAt: now.toISOString(), used: 20, resetsAt: premiumUsage.resetsAt };
      const valid = [0, 20.5, 100].map((used) => ({ ...sample, used }));
      const invalid = [
        null, [], 'sample', {},
        ...[-0.1, 100.1, null, '20'].map((used) => ({ ...sample, used })),
        ...['invalid', '', '999999-01-01', null, 0].map((observedAt) => ({ ...sample, observedAt })),
        { ...sample, resetsAt: null }, { observedAt: sample.observedAt, used: 20 },
      ];
      // JSON numeric overflow parses as Infinity, unlike JSON.stringify(Infinity), which emits null.
      const overflow = [1, -1].map((sign) => `{"observedAt":"${sample.observedAt}","used":${sign}e400,"resetsAt":"${sample.resetsAt}"}`);
      await writeFile(join(dataDir(), 'claude-usage-history.json'), `[${[...valid, ...invalid].map((row) => JSON.stringify(row)).concat(overflow).join(',')}]`);
      expect(await readUsageHistory('claude')).toEqual(valid);
    });
  });

  it('throttles samples, keeps only the current window, and caps the length', async () => {
    await withHome(async () => {
      const at = (minutes: number, used: number, base = premiumUsage): UsageSnapshot => ({ ...base, observedAt: new Date(now.getTime() + minutes * 60_000).toISOString(), weeklyUsedPercent: used });
      await saveUsage(at(0, 20));
      await saveUsage(at(2, 20));
      expect(await readUsageHistory('claude')).toHaveLength(1);
      await saveUsage(at(3, 21));
      expect(await readUsageHistory('claude')).toHaveLength(2);
      await saveUsage(at(14, 21));
      expect(await readUsageHistory('claude')).toHaveLength(3);
      const next = { ...at(20, 2), resetsAt: new Date(now.getTime() + 14 * day).toISOString() };
      await saveUsage(next);
      const pruned = await readUsageHistory('claude');
      expect(pruned).toEqual([{ observedAt: next.observedAt, used: 2, resetsAt: next.resetsAt, identityHash: 'id-1' }]);
      for (let index = 0; index < 320; index += 1) await saveUsage(at(30 + index * 11, 3 + index * 0.01, next));
      expect((await readUsageHistory('claude')).length).toBe(300);
    });
  });

  it('merges concurrent history writes', async () => {
    await withHome(async () => {
      const first = { ...premiumUsage, observedAt: now.toISOString(), weeklyUsedPercent: 20 };
      const second = { ...premiumUsage, observedAt: new Date(now.getTime() + 11 * 60_000).toISOString(), weeklyUsedPercent: 21 };
      await Promise.all([saveUsage(first), saveUsage(second)]);
      expect((await readUsageHistory('claude')).map((sample) => sample.used).sort()).toEqual([20, 21]);
    });
  });

  it('merges concurrent hook session writes and keeps the newest same-session check', async () => {
    await withHome(async () => {
      await Promise.all([
        saveHookSession('first', { state: 'premium', checkedAt: now.toISOString() }, now),
        saveHookSession('second', { state: 'run-out', checkedAt: now.toISOString() }, now),
      ]);
      expect(Object.keys(await readHookSessions()).sort()).toEqual(['first', 'second']);
      await Promise.all([
        saveHookSession('same', { state: 'old', checkedAt: now.toISOString() }, now),
        saveHookSession('same', { state: 'new', checkedAt: new Date(now.getTime() + 1_000).toISOString() }, now),
      ]);
      expect((await readHookSessions()).same?.state).toBe('new');
    });
  });

  it('carries the Codex weekly window length into the snapshot', async () => {
    await withHome(async () => {
      setEnv('SURPLUS_CODEX_BIN', join(process.cwd(), 'tests/fixtures/fake-codex.mjs'));
      setEnv('SURPLUS_TEST_WEEKLY_USED', '30');
      const discovery = await discoverCodex();
      expect(discovery?.usage?.windowMinutes).toBe(10080);
    });
  });
});

describe('hook output', () => {
  it('stays silent by default when nothing is notable, and when notices are off', async () => {
    await withHome(async () => {
      expect(await hookMessage('claude', 'session-start', { session_id: 's' }, { now })).toBeUndefined();
      await saveUsage(fastUsage);
      await saveUsage(premiumUsage);
      await saveConfig({ ...defaultConfig, features: { ...defaultFeatures, sessionNotice: false } });
      expect(await hookMessage('claude', 'session-start', { session_id: 's' }, { now })).toBeUndefined();
    });
  });

  it('announces an open premium window with a switch hint, or (active) when already on it', async () => {
    await withHome(async () => {
      await saveUsage(premiumUsage);
      const hint = await hookMessage('claude', 'session-start', { session_id: 's', model: 'claude-sonnet-4-6' }, { now });
      expect(hint).toMatch(/^surplus: premium window open · opus · 80% left · resets in 4\.0d → \/model opus$/);
      const active = await hookMessage('claude', 'session-start', { session_id: 's', model: 'claude-opus-4-8' }, { now });
      expect(active).toMatch(/\(active\)$/);
      setEnv('SURPLUS_ROUTED_TIER', 'premium');
      expect(await hookMessage('claude', 'session-start', { session_id: 's' }, { now })).toMatch(/\(active\)$/);
    });
  });

  it('uses the active workload forecast in hook advice', async () => {
    await withHome(async () => {
      await saveUsage(premiumUsage);
      await saveForecast({ provider: 'claude', resetAt: premiumUsage.resetsAt, expectedUsagePercent: 80, source: 'explicit', setAt: now.toISOString(), identityHash: 'id-1' });
      expect(await hookMessage('claude', 'session-start', { session_id: 's' }, { now })).toBeUndefined();
    });
  });

  it('warns when on pace to run out, and ignores a snapshot from another account', async () => {
    await withHome(async () => {
      await saveUsage(fastUsage);
      expect(await hookMessage('claude', 'session-start', { session_id: 's' }, { now })).toMatch(/^surplus: on pace to run out ~\d+(\.\d)?[dhm] before reset; staying on default$/);
      setEnv('SURPLUS_CLAUDE_IDENTITY_HASH', 'someone-else');
      expect(await hookMessage('claude', 'session-start', { session_id: 's' }, { now })).toBeUndefined();
    });
  });

  it('prints a systemMessage JSON line, never throws, and honours the budget', async () => {
    await withHome(async () => {
      await saveUsage(premiumUsage);
      const out = await runHook('claude', 'session-start', () => Promise.resolve({ session_id: 's' }), { now });
      expect(JSON.parse(out)).toEqual({ systemMessage: expect.stringMatching(/^surplus: premium window open/) as unknown });
      expect(await runHook('claude', 'session-start', () => Promise.reject(new Error('bad stdin')), { now })).toBe('');
      // A non-object payload degrades to "no session id, no model" rather than failing.
      expect(await runHook('claude', 'session-start', () => Promise.resolve('not an object'), { now })).toMatch(/premium window open/);
    });
  });

  it('returns empty when hook work remains pending beyond the hard budget', async () => {
    await withHome(async () => {
      vi.useFakeTimers();
      try {
        const pending = runHook('claude', 'session-start', () => new Promise<unknown>(() => {}), { now });
        await vi.advanceTimersByTimeAsync(3_001);
        await expect(pending).resolves.toBe('');
      } finally { vi.useRealTimers(); }
    });
  });

  it('codex session start uses live discovery', async () => {
    await withHome(async () => {
      const discover = (): Promise<CodexDiscovery> => Promise.resolve({
        usage: { ...premiumUsage, provider: 'codex' },
        effectiveModel: 'gpt-test', effectiveEffort: 'low', supportedEfforts: ['low', 'high'],
        models: [{ model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }],
      });
      expect(await hookMessage('codex', 'session-start', { session_id: 'c' }, { now, discover })).toBe(
        'surplus: premium window open · high effort · 80% left · resets in 4.0d → raise effort to high (/model)',
      );
    });
  });

  it('recomputes and records Codex routing state while discovery is throttled', async () => {
    await withHome(async () => {
      await saveConfig({ ...defaultConfig, features: { ...defaultFeatures, promptNudge: true } });
      const codexPremium = { ...premiumUsage, provider: 'codex' as const, identityHash: undefined };
      await saveUsage(codexPremium);
      const discover = (): Promise<CodexDiscovery> => Promise.resolve({
        usage: codexPremium, effectiveModel: 'gpt-test', effectiveEffort: 'low', supportedEfforts: ['low', 'high'],
        models: [{ model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }],
      });
      expect(await hookMessage('codex', 'prompt-submit', { session_id: 'c' }, { now, discover })).toMatch(/just opened/);
      await saveUsage({ ...codexPremium, weeklyUsedPercent: 60 });
      expect(await hookMessage('codex', 'prompt-submit', { session_id: 'c' }, { now: new Date(now.getTime() + 60_000), discover: () => Promise.reject(new Error('throttled discovery ran')) })).toMatch(/pace now says you'll run out/);
    });
  });

  it('prompt-submit is opt-in and speaks only when the state changes', async () => {
    await withHome(async () => {
      await saveUsage(premiumUsage);
      expect(await hookMessage('claude', 'prompt-submit', { session_id: 's' }, { now })).toBeUndefined();
      await saveConfig({ ...defaultConfig, features: { ...defaultFeatures, promptNudge: true } });
      const first = await hookMessage('claude', 'prompt-submit', { session_id: 's' }, { now });
      expect(first).toMatch(/^surplus: premium window just opened → \/model opus$/);
      expect(await hookMessage('claude', 'prompt-submit', { session_id: 's' }, { now })).toBeUndefined();
      // A different session is told separately.
      expect(await hookMessage('claude', 'prompt-submit', { session_id: 't' }, { now })).toMatch(/just opened/);
      // State flips to run-out: speak once, then stay quiet.
      await saveUsage(fastUsage);
      const flipped = await hookMessage('claude', 'prompt-submit', { session_id: 's' }, { now });
      expect(flipped).toMatch(/^surplus: pace now says you'll run out/);
      expect(await hookMessage('claude', 'prompt-submit', { session_id: 's' }, { now })).toBeUndefined();
      const sessions = JSON.parse(await readFile(join(dataDir(), 'hook-sessions.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(sessions).sort()).toEqual(['s', 't']);
    });
  });

  it('prunes per-session memory older than seven days', async () => {
    await withHome(async () => {
      await saveConfig({ ...defaultConfig, features: { ...defaultFeatures, promptNudge: true } });
      await saveUsage(premiumUsage);
      await hookMessage('claude', 'prompt-submit', { session_id: 'old' }, { now: new Date(now.getTime() - 8 * day) });
      await hookMessage('claude', 'prompt-submit', { session_id: 'new' }, { now });
      const sessions = JSON.parse(await readFile(join(dataDir(), 'hook-sessions.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(sessions)).toEqual(['new']);
    });
  });

  it('the hook command always exits cleanly even with bad arguments', async () => {
    await withHome(async () => {
      await main(['hook', 'claude', 'nonsense']);
      expect(process.exitCode).toBe(0);
    });
  });
});

describe('statusline segment', () => {
  it('formats premium and pace parts and appends only to the first line', () => {
    expect(withSegment('line one\nline two\n', '⚡ opus 41% 1.8d')).toBe('line one · ⚡ opus 41% 1.8d\nline two\n');
    expect(withSegment('only', '⚠ pace')).toBe('only · ⚠ pace');
    expect(withSegment('', '⚠ pace')).toBe('⚠ pace');
    expect(withSegment('unchanged\n', '')).toBe('unchanged\n');
  });

  it('is empty when the feature is off and filled when on', async () => {
    await withHome(async () => {
      const live = { ...premiumUsage, observedAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 4 * day).toISOString(), sessionResetsAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString() };
      expect(await computeSegment(live)).toBe('');
      await saveConfig({ ...defaultConfig, features: { ...defaultFeatures, statuslineSegment: true } });
      expect(await computeSegment(live)).toMatch(/^⚡ opus 80% 4\.0d$/);
      const fast = { ...live, weeklyUsedPercent: 60 };
      expect(await computeSegment(fast)).toBe('⚠ pace');
      const slow = { ...live, weeklyUsedPercent: 90 };
      expect(statuslineSegment({ tier: 'default', model: 'x', reason: '', weeklyRemainingPercent: 10, minutesUntilReset: 100 }, defaultConfig.providers.claude)).toBe('');
      expect(await computeSegment(slow)).toBe('⚠ pace');
    });
  });
});
