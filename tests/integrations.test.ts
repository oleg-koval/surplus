import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationLaunchArgs, main } from '../src/cli.js';
import { atomicJson, configPath, defaultConfig, integrationsPath, readConfig } from '../src/core/files.js';
import * as files from '../src/core/files.js';
import * as launch from '../src/core/launch.js';
import { hasExplicitOverride } from '../src/core/launch.js';
import * as claude from '../src/providers/claude.js';
import * as codex from '../src/providers/codex.js';
import * as hermes from '../src/integrations/hermes.js';
import * as pi from '../src/integrations/pi.js';
import type { SurplusConfig, UsageSnapshot } from '../src/core/types.js';
import { discoverHermes, isSimpleHermesLaunch, parseHermesUsage } from '../src/integrations/hermes.js';
import { hasPiSubscriptionAuth, isSimplePiLaunch, readPiSource } from '../src/integrations/pi.js';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const hermesDocument = (provider: string, short = true): unknown => ({
  provider, fetched_at: new Date().toISOString(), unavailable_reason: null,
  windows: [
    ...(short ? [{ label: 'Session', used_percent: 20, resets_at: new Date(Date.now() + 60 * 60_000).toISOString() }] : []),
    { label: 'Weekly', used_percent: 40, resets_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString() },
  ],
});

describe('Hermes integration', () => {
  it('keeps chat as the subcommand and preserves explicit Surplus overrides', () => {
    expect(integrationLaunchArgs('hermes', ['chat'], 'gpt-5.5', 'high')).toEqual(['chat', '--model', 'gpt-5.5', '--reasoning', 'high']);
    expect(integrationLaunchArgs('hermes', [], 'gpt-5.5', 'high')).toEqual(['--model', 'gpt-5.5', '--reasoning', 'high']);
    expect(hasExplicitOverride('hermes', ['chat'], { SURPLUS_MODEL: 'chosen' })).toBe(true);
    expect(hasExplicitOverride('hermes', [], { SURPLUS_EFFORT: 'low' })).toBe(true);
  });

  it('accepts only complete Claude or Codex subscription windows', () => {
    expect(parseHermesUsage(hermesDocument('anthropic'))?.provider).toBe('claude');
    expect(parseHermesUsage(hermesDocument('openai-codex'))?.provider).toBe('codex');
    expect(parseHermesUsage(hermesDocument('openai-codex', false))?.sessionWindow).toBe('absent');
    expect(parseHermesUsage(hermesDocument('anthropic', false))).toBeUndefined();
    expect(parseHermesUsage(hermesDocument('openrouter'))).toBeUndefined();
    const malformed = hermesDocument('openai-codex') as { windows: { used_percent: number | null }[] };
    malformed.windows[1]!.used_percent = null;
    expect(parseHermesUsage(malformed)).toBeUndefined();
  });

  it('reads the original Hermes command and leaves utility launches out of routing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-hermes-'));
    directories.push(home);
    const executable = join(home, 'hermes');
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = usage ] && [ "$2" = --json ]; then printf '%s\\n' '${JSON.stringify(hermesDocument('openai-codex'))}'; fi\n`);
    await chmod(executable, 0o755);
    expect((await discoverHermes({ HOME: home, PATH: home, SURPLUS_HERMES_BIN: executable }))?.provider).toBe('codex');
    expect(isSimpleHermesLaunch([])).toBe(true);
    expect(isSimpleHermesLaunch(['chat'])).toBe(true);
    expect(isSimpleHermesLaunch(['chat', '--model', 'x'])).toBe(false);
    expect(isSimpleHermesLaunch(['usage'])).toBe(false);
  });

  it('reports a failed usage probe only in debug mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-hermes-debug-'));
    directories.push(home);
    const executable = join(home, 'hermes');
    await writeFile(executable, '#!/bin/sh\nprintf broken-json\n');
    await chmod(executable, 0o755);
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      expect(await discoverHermes({ HOME: home, PATH: home, SURPLUS_HERMES_BIN: executable })).toBeUndefined();
      expect(lines).toEqual([]);
      expect(await discoverHermes({ HOME: home, PATH: home, SURPLUS_HERMES_BIN: executable, SURPLUS_DEBUG: '1' })).toBeUndefined();
      expect(lines.join('')).toMatch(/usage probe failed/);
    } finally { write.mockRestore(); }
  });
});

describe('Pi integration', () => {
  it('builds exact premium provider, model, and effort arguments', () => {
    expect(integrationLaunchArgs('pi', [], 'claude-opus-4-6', 'high', 'claude')).toEqual(['--provider', 'anthropic', '--model', 'claude-opus-4-6', '--thinking', 'high']);
    expect(integrationLaunchArgs('pi', [], 'gpt-5.5', 'xhigh', 'codex')).toEqual(['--provider', 'openai-codex', '--model', 'gpt-5.5', '--thinking', 'xhigh']);
    expect(hasExplicitOverride('pi', [], { SURPLUS_MODEL: 'chosen' })).toBe(true);
    expect(hasExplicitOverride('pi', [], { SURPLUS_EFFORT: 'low' })).toBe(true);
  });

  it('requires Pi to report OAuth rather than API-key authentication', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-pi-auth-'));
    directories.push(home);
    const executable = join(home, 'pi');
    await writeFile(executable, '#!/bin/sh\n[ "$1" = auth ] && [ "$2" = check ] && [ "$3" = --provider ] && [ "$5" = --json ] && [ "$6" = --no-refresh ] || exit 3\nif [ "$4" = anthropic ]; then printf \'%s\\n\' \'{"status":"ready","provider":"anthropic","authType":"oauth"}\'; else printf \'%s\\n\' \'{"status":"ready","provider":"openai-codex","authType":"api_key"}\'; fi\n');
    await chmod(executable, 0o755);
    const env = { HOME: home, PATH: home, SURPLUS_PI_BIN: executable };
    expect(await hasPiSubscriptionAuth('claude', env)).toBe(true);
    expect(await hasPiSubscriptionAuth('codex', env)).toBe(false);
  });

  it('reports a failed auth probe only in debug mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-pi-debug-'));
    directories.push(home);
    const executable = join(home, 'pi');
    await writeFile(executable, '#!/bin/sh\nprintf broken-json\n');
    await chmod(executable, 0o755);
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      expect(await hasPiSubscriptionAuth('claude', { HOME: home, PATH: home, SURPLUS_PI_BIN: executable })).toBe(false);
      expect(lines).toEqual([]);
      expect(await hasPiSubscriptionAuth('claude', { HOME: home, PATH: home, SURPLUS_PI_BIN: executable, SURPLUS_DEBUG: '1' })).toBe(false);
      expect(lines.join('')).toMatch(/auth check failed/);
    } finally { write.mockRestore(); }
  });

  it('selects both supported subscriptions from Pi settings and skips project overrides', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-pi-'));
    directories.push(home);
    const agentDir = join(home, '.pi', 'agent');
    const project = join(home, 'project');
    await mkdir(agentDir, { recursive: true });
    await mkdir(project);
    const settings = join(agentDir, 'settings.json');
    await writeFile(settings, JSON.stringify({ defaultProvider: 'anthropic' }));
    expect(await readPiSource({ HOME: home }, project)).toBe('claude');
    await writeFile(settings, JSON.stringify({ defaultProvider: 'openai-codex' }));
    expect(await readPiSource({ HOME: home }, project)).toBe('codex');
    await mkdir(join(project, '.pi'));
    await writeFile(join(project, '.pi', 'settings.json'), '{}');
    expect(await readPiSource({ HOME: home }, project)).toBeUndefined();
    expect(isSimplePiLaunch([])).toBe(true);
    expect(isSimplePiLaunch(['--continue'])).toBe(false);
  });

  it('stores separate Pi targets while preserving older configurations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-pi-config-'));
    directories.push(home);
    const prior = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const providers = {
        claude: { ...defaultConfig.providers.claude, premiumModel: 'saved-claude', reservePercent: 17 },
        codex: { ...defaultConfig.providers.codex, premiumModel: 'saved-codex', premiumEffort: 'xhigh' },
      };
      await atomicJson(configPath(), { version: 1, providers, features: defaultConfig.features,
        integrations: { hermes: { premiumModel: 'saved-hermes' }, pi: { sources: { claude: { premiumModel: 'old-claude' } } } } });
      await main(['configure', 'pi', '--source', 'claude', '--premium', 'claude-opus-4-6']);
      await main(['configure', 'pi', '--source', 'codex', '--premium', 'gpt-5.5', '--effort', 'high']);
      await main(['configure', 'pi', '--source', 'codex', '--premium', 'gpt-5.6']);
      const config = await readConfig();
      expect(config.integrations.pi.sources).toEqual({
        claude: { premiumModel: 'claude-opus-4-6' }, codex: { premiumModel: 'gpt-5.6', premiumEffort: 'high' },
      });
      expect(config.integrations.hermes.premiumModel).toBe('saved-hermes');
      expect(config.providers.claude.premiumModel).toBe('saved-claude');
      expect(config.providers.claude.reservePercent).toBe(17);
      expect(config.providers.codex.premiumModel).toBe('saved-codex');
      expect(config.providers.codex.premiumEffort).toBe('xhigh');
      expect(JSON.parse(await readFile(integrationsPath(), 'utf8'))).toHaveProperty('pi.sources.codex.premiumEffort', 'high');
      await atomicJson(configPath(), { version: 1, providers, features: defaultConfig.features });
      expect((await readConfig()).integrations.pi.sources?.codex?.premiumModel).toBe('gpt-5.6');
      expect((await readConfig()).integrations.hermes.premiumModel).toBe('saved-hermes');
    } finally {
      output.mockRestore();
      if (prior.HOME === undefined) delete process.env.HOME; else process.env.HOME = prior.HOME;
      if (prior.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior.XDG_CONFIG_HOME;
    }
  });

  it('uses Codex quota for an OAuth-backed Pi status decision', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-pi-status-'));
    directories.push(home);
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_PI_BIN', 'SURPLUS_CODEX_BIN', 'SURPLUS_TEST_WEEKLY_USED', 'OPENAI_API_KEY'] as const;
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
    const piBin = join(home, 'pi');
    const agentDir = join(home, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex' }));
    await writeFile(piBin, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ready","provider":"openai-codex","authType":"oauth"}\'\n');
    await chmod(piBin, 0o755);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_STATE_HOME = join(home, 'state');
    process.env.SURPLUS_PI_BIN = piBin;
    process.env.SURPLUS_CODEX_BIN = join(process.cwd(), 'tests', 'fixtures', 'fake-codex.mjs');
    process.env.SURPLUS_TEST_WEEKLY_USED = '60';
    delete process.env.OPENAI_API_KEY;
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    try {
      await main(['configure', 'pi', '--source', 'codex', '--premium', 'gpt-test', '--effort', 'high']);
      await main(['status', 'pi']);
      expect(output.join('')).toMatch(/PREMIUM · gpt-test · 40\.0% weekly remaining/);
      process.env.SURPLUS_TEST_WEEKLY_USED = '90';
      await main(['status', 'pi']);
      expect(output.join('')).toMatch(/DEFAULT · provider default · 10\.0% weekly remaining/);
    } finally {
      write.mockRestore();
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
      }
    }
  });
});

describe.each([
  ['hermes', 'claude', ['chat'], ['chat', '--model', 'integration-premium', '--reasoning', 'high']],
  ['hermes', 'codex', [], ['--model', 'integration-premium', '--reasoning', 'high']],
  ['pi', 'claude', [], ['--provider', 'anthropic', '--model', 'integration-premium', '--thinking', 'high']],
  ['pi', 'codex', [], ['--provider', 'openai-codex', '--model', 'integration-premium', '--thinking', 'high']],
] as const)('%s routing with %s quota', (integration, source, args, premiumArgs) => {
  let usage: UsageSnapshot;
  let config: SurplusConfig;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    const now = Date.now();
    usage = {
      provider: source, observedAt: new Date(now).toISOString(), weeklyUsedPercent: 40,
      resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(), usageAllowed: true,
      sessionWindow: 'available', sessionUsedPercent: 20,
      sessionResetsAt: new Date(now + 60 * 60_000).toISOString(), identityHash: 'test-account',
    };
    const target = { premiumModel: 'integration-premium', premiumEffort: 'high' };
    config = {
      ...files.defaultConfig,
      integrations: { hermes: target, pi: { sources: { [source]: target } } },
    };
    vi.spyOn(files, 'readConfig').mockImplementation(async () => config);
    vi.spyOn(files, 'readState').mockResolvedValue(undefined);
    vi.spyOn(files, 'readUsageHistory').mockResolvedValue([]);
    vi.spyOn(files, 'readForecast').mockResolvedValue(undefined);
    vi.spyOn(files, 'readClaudeIdentity').mockResolvedValue('test-account');
    vi.spyOn(files, 'readUsage').mockImplementation(async () => usage);
    vi.spyOn(claude, 'readClaudeIdentityHash').mockReturnValue('test-account');
    vi.spyOn(hermes, 'discoverHermes').mockImplementation(async () => usage);
    vi.spyOn(pi, 'readPiSource').mockResolvedValue(source);
    vi.spyOn(pi, 'hasPiSubscriptionAuth').mockResolvedValue(true);
    vi.spyOn(codex, 'discoverCodex').mockImplementation(async () => ({ usage, models: [], supportedEfforts: [] }));
    vi.spyOn(launch, 'shouldAutomaticallyRoute').mockReturnValue(true);
    vi.spyOn(launch, 'launchProvider').mockResolvedValue(0);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  const expectPremiumLaunch = (): void => {
    expect(launch.launchProvider).toHaveBeenCalledExactlyOnceWith(
      integration, premiumArgs, expect.objectContaining({ SURPLUS_ROUTED_TIER: 'premium' }),
    );
  };

  it('launches the exact premium provider, model, and effort arguments', async () => {
    await main(['run', integration, ...args]);
    expectPremiumLaunch();
    expect(files.readState).toHaveBeenCalledExactlyOnceWith(source);
    expect(files.readUsageHistory).toHaveBeenCalledExactlyOnceWith(source);
    expect(files.readForecast).toHaveBeenCalledExactlyOnceWith(source);
  });

  it.each([true, false])('applies previous premium hysteresis only in the same reset window (%s)', async (sameWindow) => {
    config = { ...config, providers: { ...config.providers, [source]: { ...config.providers[source], strategy: 'near-reset' } } };
    usage = { ...usage, weeklyUsedPercent: 78 };
    vi.mocked(files.readState).mockImplementation(async (provider) => provider === source ? {
      tier: 'premium', resetAt: sameWindow ? usage.resetsAt : usage.observedAt, observedAt: usage.observedAt,
    } : undefined);
    await main(['run', integration, ...args]);
    if (sameWindow) expectPremiumLaunch();
    else expect(launch.launchProvider).toHaveBeenCalledExactlyOnceWith(integration, args);
  });

  it('uses source history to avoid premium when recent usage is too fast', async () => {
    vi.mocked(files.readUsageHistory).mockImplementation(async (provider) => provider === source ? [{
      observedAt: new Date(Date.parse(usage.observedAt) - 2 * 60 * 60_000).toISOString(),
      used: 20, resetsAt: usage.resetsAt, identityHash: usage.identityHash,
    }] : []);
    await main(['run', integration, ...args]);
    expect(launch.launchProvider).toHaveBeenCalledExactlyOnceWith(integration, args);
  });

  it.each([true, false])('applies a workload forecast only for the matching reset window (%s)', async (sameWindow) => {
    vi.mocked(files.readForecast).mockImplementation(async (provider) => provider === source ? {
      provider: source, resetAt: sameWindow ? usage.resetsAt : usage.observedAt,
      expectedUsagePercent: 70, source: 'explicit', setAt: usage.observedAt, identityHash: usage.identityHash,
    } : undefined);
    await main(['run', integration, ...args]);
    if (sameWindow) expect(launch.launchProvider).toHaveBeenCalledExactlyOnceWith(integration, args);
    else expectPremiumLaunch();
  });
});
