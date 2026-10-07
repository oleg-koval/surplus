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
  it('does not persist premium hysteresis before a real provider launch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-status-readonly-'));
    homes.push(home);
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_CODEX_BIN', 'SURPLUS_TEST_WEEKLY_USED', 'SURPLUS_TEST_PROVIDER_ARGS'];
    keys.forEach(saveEnv);
    const provider = join(process.cwd(), 'tests/fixtures/fake-codex.mjs');
    const providerArgsPath = join(home, 'provider-args.jsonl');
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.XDG_STATE_HOME = join(home, 'state');
    process.env.SURPLUS_CODEX_BIN = provider;
    process.env.SURPLUS_TEST_PROVIDER_ARGS = providerArgsPath;

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      process.env.SURPLUS_TEST_WEEKLY_USED = '74';
      await main(['status', 'codex']);
      const statePath = join(home, 'state/surplus/codex-state.json');
      await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      process.env.SURPLUS_TEST_WEEKLY_USED = '78';
      await main(['run', 'codex', 'task']);
      const args = (await readFile(providerArgsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
      expect(args).toEqual([['task']]);
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ tier: 'default' });
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
  });
});
