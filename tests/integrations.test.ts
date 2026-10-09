import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { readConfig } from '../src/core/files.js';
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
});

describe('Pi integration', () => {
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
      await main(['configure', 'pi', '--source', 'claude', '--premium', 'claude-opus-4-6']);
      await main(['configure', 'pi', '--source', 'codex', '--premium', 'gpt-5.5', '--effort', 'high']);
      const config = await readConfig();
      expect(config.integrations.pi.sources).toEqual({
        claude: { premiumModel: 'claude-opus-4-6' }, codex: { premiumModel: 'gpt-5.5', premiumEffort: 'high' },
      });
      expect(JSON.parse(await readFile(join(home, 'config', 'surplus', 'config.json'), 'utf8'))).toHaveProperty('providers.codex');
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
      expect(output.join('')).toMatch(/PREMIUM · gpt-test/);
    } finally {
      write.mockRestore();
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
      }
    }
  });
});
