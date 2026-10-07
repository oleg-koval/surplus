import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

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
});
