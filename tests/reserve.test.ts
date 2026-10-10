import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { defaultConfig, readConfig, saveForecast, saveState } from '../src/core/files.js';

const homes: string[] = [];
const savedEnv = new Map<string, string | undefined>();

const useTempHome = async (): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'surplus-reserve-'));
  homes.push(home);
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_CODEX_BIN', 'SURPLUS_TEST_WEEKLY_USED', 'SURPLUS_TEST_RESETS_AT']) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  process.env.XDG_STATE_HOME = join(home, 'state');
  process.env.SURPLUS_CODEX_BIN = join(process.cwd(), 'tests/fixtures/fake-codex.mjs');
  process.env.SURPLUS_TEST_WEEKLY_USED = '75';
  process.env.SURPLUS_TEST_RESETS_AT = String(Math.floor((Date.now() + 60 * 60_000) / 1_000));
};

const captureStatus = async (): Promise<string> => {
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  try { await main(['status', 'codex']); } finally { write.mockRestore(); }
  return output.join('');
};

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('persistent reserve CLI', () => {
  it('saves a reserve without changing other preferences or the other provider', async () => {
    await useTempHome();
    await main(['configure', 'codex', '--premium', 'gpt-test', '--reserve', '12.5']);
    const config = await readConfig();
    expect(config.providers.codex).toMatchObject({ premiumModel: 'gpt-test', premiumEffort: 'high', reservePercent: 12.5 });
    expect(config.providers.claude).toEqual(defaultConfig.providers.claude);

    await main(['configure', 'codex', '--reserve', '0']);
    expect((await readConfig()).providers.codex).toMatchObject({ premiumModel: 'gpt-test', reservePercent: 0 });
  });

  it.each(['-1', '101', 'NaN', '1e2', '10%', ''])('rejects invalid reserve %s without changing config', async (value) => {
    await useTempHome();
    await expect(main(['configure', 'codex', '--reserve', value])).rejects.toThrow();
    expect(await readConfig()).toEqual(defaultConfig);
  });

  it('shows which weekly guard binds at the boundary', async () => {
    await useTempHome();
    await main(['configure', 'codex', '--reserve', '19']);
    expect(await captureStatus()).toContain('Weekly guard: 25% remaining (25% weekly floor; 19% reserve + 5% expected usage).');

    await main(['configure', 'codex', '--reserve', '21']);
    expect(await captureStatus()).toContain('Weekly guard: 26% remaining (25% weekly floor; 21% reserve + 5% expected usage).');
  });

  it('shows the forecast and hysteresis guards for an existing premium window', async () => {
    await useTempHome();
    await main(['configure', 'codex', '--reserve', '17']);
    const resetAt = new Date(Number(process.env.SURPLUS_TEST_RESETS_AT) * 1_000).toISOString();
    await saveState('codex', { tier: 'premium', resetAt, observedAt: new Date().toISOString() });
    await saveForecast({ provider: 'codex', resetAt, expectedUsagePercent: 30, source: 'explicit', setAt: new Date().toISOString() });

    const output = await captureStatus();
    expect(output).toContain('Weekly guard: 47% remaining (20% weekly floor');
    expect(output).toContain('17% reserve + 30% expected usage');
    expect(output).toContain('Pace guard: 22% projected unused (17% reserve + 5% margin).');
    expect(output).toContain('Workload forecast: 30% expected usage before reset');
  });
});
