import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { configPath, dataDir, defaultConfig, readLaunchDebit, saveClaudeIdentity, saveUsage } from '../src/core/files.js';
import type { UsageSnapshot } from '../src/core/types.js';

const homes: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const saveEnv = (key: string): void => { if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]); };
const originalExecve = process.execve;
const ttyDescriptors = new Map<'stdin' | 'stdout', PropertyDescriptor | undefined>();

const setTty = (stream: 'stdin' | 'stdout', value: boolean): void => {
  ttyDescriptors.set(stream, Object.getOwnPropertyDescriptor(process[stream], 'isTTY'));
  Object.defineProperty(process[stream], 'isTTY', { value, configurable: true });
};

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  savedEnv.clear();
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) Object.defineProperty(process[stream], 'isTTY', descriptor); else Reflect.deleteProperty(process[stream], 'isTTY');
  }
  ttyDescriptors.clear();
  Object.defineProperty(process, 'execve', { value: originalExecve, configurable: true, writable: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** Builds a temp home with a fake logged-in Claude executable, a cached sample, and the given per-launch debit; returns the sample. */
const setup = async (debitPercent: number): Promise<UsageSnapshot> => {
  const home = await mkdtemp(join(tmpdir(), 'surplus-debit-launch-'));
  homes.push(home);
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SURPLUS_CLAUDE_BIN', 'SURPLUS_MODEL', 'SURPLUS_EFFORT', 'ANTHROPIC_MODEL']) saveEnv(key);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  process.env.XDG_STATE_HOME = join(home, 'state');
  delete process.env.SURPLUS_MODEL; delete process.env.SURPLUS_EFFORT; delete process.env.ANTHROPIC_MODEL;
  const fake = join(home, 'claude');
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgId":"org","subscriptionType":"max"}'; fi\nexit 0\n`);
  await chmod(fake, 0o755);
  process.env.SURPLUS_CLAUDE_BIN = fake;
  const identityHash = createHash('sha256').update('a@b.c\norg\nmax').digest('hex');
  const now = Date.now();
  const sample: UsageSnapshot = {
    provider: 'claude', observedAt: new Date(now - 60_000).toISOString(), weeklyUsedPercent: 20, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    sessionWindow: 'available', sessionUsedPercent: 10, sessionResetsAt: new Date(now + 4 * 60 * 60_000).toISOString(), usageAllowed: true, identityHash,
  };
  await saveUsage(sample);
  await saveClaudeIdentity(identityHash);
  await mkdir(dirname(configPath()), { recursive: true });
  const claude = { ...defaultConfig.providers.claude, premiumLaunchDebitPercent: debitPercent };
  await writeFile(configPath(), JSON.stringify({ version: 1, providers: { claude, codex: defaultConfig.providers.codex } }), 'utf8');
  setTty('stdin', true); setTty('stdout', true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return sample;
};

const stubExecve = (behavior: 'record' | 'fail'): string[][] => {
  const calls: string[][] = [];
  Object.defineProperty(process, 'execve', {
    value: (_file: string, argv: string[]) => { calls.push(argv.slice(1)); if (behavior === 'fail') throw new Error('execve failed'); },
    configurable: true, writable: true,
  });
  return calls;
};

describe.skipIf(process.platform === 'win32')('Claude launch debit through run()', () => {
  it('lets the first premium launch change the next launch decision on the same sample', async () => {
    const sample = await setup(40);
    const calls = stubExecve('record');

    await main(['run', 'claude']);
    expect((await readLaunchDebit('claude'))?.percent).toBe(40);
    await main(['run', 'claude']);
    expect((await readLaunchDebit('claude'))?.percent).toBe(80);
    await main(['run', 'claude']);

    // The stub returns, so each launch also spawns the fake executable once more; only execve calls are recorded here.
    expect(calls.map((argv) => argv.includes('--model'))).toEqual([true, true, false]);
    expect((await readLaunchDebit('claude'))?.percent).toBe(80);
    expect(JSON.parse(await readFile(join(dataDir(), 'claude-usage.json'), 'utf8')).weeklyUsedPercent).toBe(sample.weeklyUsedPercent);
  });

  it('does not debit when the debit is disabled', async () => {
    await setup(0);
    const calls = stubExecve('record');
    await main(['run', 'claude']);
    await main(['run', 'claude']);
    expect(calls.map((argv) => argv.includes('--model'))).toEqual([true, true]);
    await expect(readLaunchDebit('claude')).resolves.toBeUndefined();
  });

  it('does not debit override or non-interactive launches', async () => {
    await setup(40);
    const calls = stubExecve('record');
    await main(['run', 'claude', '--model', 'sonnet']);
    setTty('stdin', false);
    await main(['run', 'claude']);
    expect(calls).toHaveLength(2);
    await expect(readLaunchDebit('claude')).resolves.toBeUndefined();
  });

  it('gives the debit back when the provider fails to start', async () => {
    await setup(40);
    stubExecve('fail');
    await expect(main(['run', 'claude'])).rejects.toThrow('execve failed');
    await expect(readLaunchDebit('claude')).resolves.toBeUndefined();
  });

  it('reserves one debit per launch when launches run concurrently', async () => {
    await setup(10);
    stubExecve('record');
    await Promise.all([main(['run', 'claude']), main(['run', 'claude'])]);
    const percent = (await readLaunchDebit('claude'))?.percent ?? 0;
    // A launch that cannot take the short lock decides without a reservation, so only the upper bound is exact.
    expect(percent).toBeGreaterThanOrEqual(10);
    expect(percent).toBeLessThanOrEqual(20);
  });
});
