import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeStatusLine, readClaudeIdentityHash } from '../src/providers/claude.js';
import { codexLimitSnapshot, codexWindows, selectEffectiveCodexModel } from '../src/providers/codex.js';
import { codexUpgradeConfig } from '../src/core/codex-policy.js';
import { defaultConfig } from '../src/core/files.js';
import { decide } from '../src/core/policy.js';

const now = new Date('2026-10-07T12:00:00.000Z');

describe('Claude statusline telemetry', () => {
  it('parses independent five-hour and seven-day windows with epoch reset times', () => {
    const snapshot = parseClaudeStatusLine({ rate_limits: {
      five_hour: { used_percentage: 10, resets_at: now.getTime() / 1000 + 3600 },
      seven_day: { used_percentage: 65, resets_at: now.getTime() / 1000 + 86400 },
    } }, now);
    expect(snapshot?.weeklyUsedPercent).toBe(65);
    expect(snapshot?.sessionUsedPercent).toBe(10);
    expect(snapshot?.resetsAt).toBe('2026-10-08T12:00:00.000Z');
  });

  it('rejects missing or out-of-range provider values', () => {
    expect(parseClaudeStatusLine({ rate_limits: { seven_day: { used_percentage: 20, resets_at: 1 } } }, now)).toBeUndefined();
    expect(parseClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 120, resets_at: 1 }, seven_day: { used_percentage: 20, resets_at: 1 } } }, now)).toBeUndefined();
  });

  it('skips a directory named claude and reads identity from the real executable later in PATH', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'surplus-claude-auth-'));
    try {
      const directoryBin = join(fixture, 'directory-bin');
      const managedBin = join(fixture, '.local', 'state', 'surplus', 'bin');
      const managedBinAlias = join(fixture, 'managed-bin-alias');
      const fileAliasBin = join(fixture, 'file-alias-bin');
      const providerBin = join(fixture, 'provider-bin');
      await Promise.all([mkdir(join(directoryBin, 'claude'), { recursive: true }), mkdir(managedBin, { recursive: true }), mkdir(fileAliasBin), mkdir(providerBin)]);
      const identity = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'Fixture@Example.test', orgId: 'org-1', subscriptionType: 'pro' };
      const managedWrapper = join(managedBin, 'claude');
      await writeFile(managedWrapper, '#!/bin/sh\nexit 99\n');
      await chmod(managedWrapper, 0o755);
      await symlink(managedBin, managedBinAlias, 'dir');
      await symlink(managedWrapper, join(fileAliasBin, 'claude'));
      const executable = join(providerBin, 'claude');
      await writeFile(executable, `#!/bin/sh\nprintf '%s' '${JSON.stringify(identity)}'\n`);
      await chmod(executable, 0o755);

      const identityHash = readClaudeIdentityHash({ PATH: [fileAliasBin, `${managedBin}/`, managedBinAlias, directoryBin, providerBin].join(':'), HOME: fixture });

      expect(identityHash).toBe(createHash('sha256').update('fixture@example.test\norg-1\npro').digest('hex'));
      expect(readClaudeIdentityHash({ SURPLUS_CLAUDE_BIN: join(fileAliasBin, 'claude'), HOME: fixture })).toBeUndefined();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe('Codex window selection', () => {
  it('uses the codex bucket when the map exists and rejects a mismatched legacy bucket', () => {
    const codex = { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 10080 } };
    const other = { limitId: 'codex_other', primary: { usedPercent: 12, windowDurationMins: 10080 } };
    expect(codexLimitSnapshot({ rateLimitsByLimitId: { codex: other }, rateLimits: codex })).toBe(other);
    expect(codexLimitSnapshot({ rateLimitsByLimitId: { codex_other: other }, rateLimits: codex })).toBeUndefined();
    expect(codexLimitSnapshot({ rateLimits: other })).toBeUndefined();
    expect(codexLimitSnapshot({ rateLimits: codex })).toBe(codex);
  });

  it('classifies weekly and short windows by their durations, independent of primary/secondary order', () => {
    const windows = codexWindows({ primary: { usedPercent: 12, windowDurationMins: 10080 }, secondary: { usedPercent: 40, windowDurationMins: 300 } });
    expect(windows.weekly?.usedPercent).toBe(12);
    expect(windows.session?.usedPercent).toBe(40);
  });

  it('does not guess when a provider window lacks duration metadata', () => {
    expect(codexWindows({ primary: { usedPercent: 12 }, secondary: { usedPercent: 40 } }).sessionWindow).toBe('invalid');
  });

  it('marks a missing short window only when the sole reported window is weekly', () => {
    expect(codexWindows({ primary: { usedPercent: 12, windowDurationMins: 10080 }, secondary: null }).sessionWindow).toBe('absent');
    expect(codexWindows({ primary: { usedPercent: 12, windowDurationMins: 10080 }, secondary: { usedPercent: 0 } }).sessionWindow).toBe('invalid');
  });

  it('uses the catalog default only when Codex config has no explicit model', () => {
    const models = [{ model: 'catalog-default', isDefault: true }, { model: 'other', isDefault: false }];
    expect(selectEffectiveCodexModel(null, models)?.model).toBe('catalog-default');
    expect(selectEffectiveCodexModel('other', models)?.model).toBe('other');
    expect(selectEffectiveCodexModel('unknown', models)).toBeUndefined();
  });
});

describe('Codex effort upgrade guard', () => {
  const config = defaultConfig.providers.codex;
  const discovery = {
    usage: { provider: 'codex' as const, observedAt: now.toISOString(), weeklyUsedPercent: 20, resetsAt: new Date(now.getTime() + 60_000).toISOString(), sessionWindow: 'available' as const, sessionUsedPercent: 10, sessionResetsAt: new Date(now.getTime() + 60_000).toISOString(), usageAllowed: true },
    effectiveModel: 'gpt-default', effectiveEffort: 'low', supportedEfforts: ['low', 'high'],
    models: [{ model: 'gpt-default', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }],
  };

  it('only raises reasoning for the effective model when the catalog confirms it', () => {
    expect(codexUpgradeConfig(config, discovery).premiumEffort).toBe('high');
    expect(codexUpgradeConfig(config, { ...discovery, effectiveEffort: 'xhigh' })).toMatchObject({ minWeeklyRemainingPercent: 101, hysteresisPercent: 0 });
    expect(codexUpgradeConfig(config, { ...discovery, effectiveModel: undefined })).toMatchObject({ minWeeklyRemainingPercent: 101, hysteresisPercent: 0 });
  });

  it('stays default with full weekly headroom when the current effort cannot safely be raised', () => {
    if (!discovery.usage) throw new Error('fixture usage is required');
    const resetAt = discovery.usage.resetsAt;
    const previous = { tier: 'premium' as const, resetAt, observedAt: now.toISOString() };
    const cases = [
      { ...discovery, effectiveEffort: 'xhigh' },
      { ...discovery, effectiveEffort: 'unrecognized-effort' },
      { ...discovery, models: [] },
    ];

    for (const candidate of cases) {
      const disabled = codexUpgradeConfig(config, candidate);
      const decision = decide({
        usage: { ...discovery.usage, weeklyUsedPercent: 0 }, config: disabled, previous, now,
      });
      expect(decision.tier).toBe('default');
      expect(disabled.hysteresisPercent).toBe(0);
    }
  });

  it('permits an explicitly configured premium model when its requested effort is supported', () => {
    const explicit = { ...config, premiumModel: 'gpt-default' };
    expect(codexUpgradeConfig(explicit, { ...discovery, effectiveEffort: 'xhigh' }).premiumModel).toBe('gpt-default');
  });
});
