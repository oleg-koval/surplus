import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { saveForecast } from '../src/core/files.js';

const homes: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const saveEnv = (key: string): void => { if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]); };
const restoreEnv = (): void => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
};

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  restoreEnv();
});

describe('read-only status decisions', () => {
  it('shows a premium status decision without persisting routing hysteresis', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-status-readonly-'));
    homes.push(home);
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_CODEX_BIN', 'SURPLUS_TEST_WEEKLY_USED'];
    keys.forEach(saveEnv);
    const provider = join(process.cwd(), 'tests/fixtures/fake-codex.mjs');
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_STATE_HOME = join(home, 'state');
    process.env.SURPLUS_CODEX_BIN = provider;
    process.env.SURPLUS_TEST_WEEKLY_USED = '74';
    await main(['status', 'codex']);
    const statePath = join(home, 'state/surplus/codex-state.json');
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an expired forecast even when the live provider probe has no usage telemetry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-status-expired-'));
    homes.push(home);
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_CODEX_BIN', 'SURPLUS_TEST_WEEKLY_USED'];
    keys.forEach(saveEnv);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_STATE_HOME = join(home, 'state');
    process.env.SURPLUS_CODEX_BIN = join(process.cwd(), 'tests/fixtures/fake-codex.mjs');
    process.env.SURPLUS_TEST_WEEKLY_USED = '74';
    await saveForecast({ provider: 'codex', resetAt: new Date(Date.now() - 1_000).toISOString(), expectedUsagePercent: 40, source: 'explicit', setAt: new Date().toISOString() });
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    try { await main(['status', 'codex']); } finally { write.mockRestore(); }
    expect(output.join('')).toMatch(/expired with the previous reset window/);
    expect(output.join('')).not.toMatch(/current telemetry unavailable/);
  });

  it('changes the real CLI status decision when a matching forecast is saved', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-status-forecast-'));
    homes.push(home);
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_CODEX_BIN', 'SURPLUS_TEST_WEEKLY_USED', 'SURPLUS_TEST_RESETS_AT'];
    keys.forEach(saveEnv);
    const resetSeconds = Math.floor((Date.now() + 60 * 60_000) / 1_000);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_STATE_HOME = join(home, 'state');
    process.env.SURPLUS_CODEX_BIN = join(process.cwd(), 'tests/fixtures/fake-codex.mjs');
    process.env.SURPLUS_TEST_WEEKLY_USED = '74';
    process.env.SURPLUS_TEST_RESETS_AT = String(resetSeconds);
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    try {
      await main(['status', 'codex']);
      await saveForecast({ provider: 'codex', resetAt: new Date(resetSeconds * 1_000).toISOString(), expectedUsagePercent: 30, source: 'explicit', setAt: new Date().toISOString() });
      await main(['status', 'codex']);
    } finally { write.mockRestore(); }
    const text = output.join('');
    expect(text).toMatch(/PREMIUM ·/);
    expect(text).toMatch(/DEFAULT ·/);
    expect(text).toMatch(/effective expected usage: 30%/);
  });
});
