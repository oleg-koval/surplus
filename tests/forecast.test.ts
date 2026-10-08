import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearForecast,
  dataDir,
  readActiveForecast,
  readForecast,
  saveForecast,
  saveUsage,
} from '../src/core/files.js';
import { main } from '../src/cli.js';
import type { UsageSnapshot, WorkloadForecast } from '../src/core/types.js';

const homes: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const saveEnv = (key: string): void => { if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]); };
const useTempHome = async (): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'surplus-forecast-'));
  homes.push(home);
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) saveEnv(key);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  process.env.XDG_STATE_HOME = join(home, 'state');
};

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

const forecast: WorkloadForecast = {
  provider: 'claude',
  resetAt: '2026-10-08T12:00:00.000Z',
  expectedUsagePercent: 20,
  source: 'explicit',
  setAt: '2026-10-07T12:00:00.000Z',
};

describe('workload forecast persistence', () => {
  it('saves, reads, matches by reset window, and clears a forecast', async () => {
    await useTempHome();
    await saveForecast(forecast);

    await expect(readForecast('claude')).resolves.toEqual(forecast);
    await expect(readActiveForecast('claude', forecast.resetAt)).resolves.toEqual(forecast);
    await expect(readActiveForecast('claude', '2026-10-15T12:00:00.000Z')).resolves.toBeUndefined();

    await clearForecast('claude');
    await expect(readForecast('claude')).resolves.toBeUndefined();
  });

  it('ignores malformed forecast state', async () => {
    await useTempHome();
    const path = join(dataDir(), 'claude-forecast.json');
    await mkdir(dataDir(), { recursive: true });
    await writeFile(path, '{"expectedUsagePercent":"not-a-number"}', 'utf8');

    await expect(readForecast('claude')).resolves.toBeUndefined();
    await expect(readFile(path, 'utf8')).resolves.toContain('not-a-number');
  });
});

describe('forecast CLI', () => {
  it('sets, reports, and clears a provider forecast for the cached reset window', async () => {
    await useTempHome();
    const usage: UsageSnapshot = {
      provider: 'claude', observedAt: '2030-10-07T12:00:00.000Z', weeklyUsedPercent: 40,
      resetsAt: '2030-10-15T12:00:00.000Z', sessionWindow: 'available', sessionUsedPercent: 10,
      sessionResetsAt: '2030-10-07T17:00:00.000Z', usageAllowed: true,
    };
    await saveUsage(usage);
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    try {
      await main(['forecast', 'claude', '20']);
      await expect(readForecast('claude')).resolves.toMatchObject({ expectedUsagePercent: 20, resetAt: usage.resetsAt });
      await main(['forecast', 'claude', 'status']);
      await main(['forecast', 'claude', 'clear']);
      await expect(readForecast('claude')).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
    expect(output.join('')).toContain('Saved a 20% claude workload forecast');
    expect(output.join('')).toContain('Workload forecast: 20%');
    expect(output.join('')).toContain('Cleared the claude workload forecast');
  });

  it('rejects an invalid percentage', async () => {
    await useTempHome();
    await expect(main(['forecast', 'claude', '101'])).rejects.toThrow('Forecast must be a number from 0 to 100');
  });
});
