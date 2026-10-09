import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNewerRelease, runAutoUpdate, scheduleAutoUpdate, updateIntervalMs } from '../src/core/auto-update.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })) };
});

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'surplus-update-')));
  homes.push(home);
  const prefix = join(home, 'node prefix');
  const root = join(prefix, 'lib/node_modules/surplus-cli');
  const cli = join(root, 'dist/cli.js');
  const bin = join(home, 'bin');
  const state = join(home, 'state/surplus/auto-update.json');
  const log = join(home, 'npm-log.jsonl');
  await Promise.all([mkdir(join(root, 'dist'), { recursive: true }), mkdir(bin), mkdir(join(home, 'state/surplus'), { recursive: true })]);
  await writeFile(cli, '');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'surplus-cli', version: '1.0.0' }));
  const npm = join(bin, 'npm');
  await writeFile(npm, `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.SURPLUS_TEST_LOG, JSON.stringify(args) + '\\n');
if (process.env.SURPLUS_TEST_FAIL === '1') process.exit(1);
if (args[0] === 'view') console.log(JSON.stringify(process.env.SURPLUS_TEST_LATEST));
if (args[0] === 'install') {
  const prefix = args[args.indexOf('--prefix') + 1];
  const version = args.find(arg => arg.startsWith('surplus-cli@')).slice('surplus-cli@'.length);
  writeFileSync(join(prefix, 'lib/node_modules/surplus-cli/package.json'), JSON.stringify({ name: 'surplus-cli', version }));
}
`);
  await chmod(npm, 0o755);
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, 'state'), PATH: bin,
    SURPLUS_AUTO_UPDATE: '1', SURPLUS_TEST_LOG: log, SURPLUS_TEST_LATEST: '1.1.0' };
  return { home, prefix, root, cli, state, log, env };
};

describe('automatic updates', () => {
  it('reserves one check across concurrent triggers, including failures, until six hours pass', async () => {
    const f = await fixture();
    const spawn = vi.mocked(childProcess.spawn);
    const now = new Date('2026-10-09T12:00:00Z');
    await Promise.all(Array.from({ length: 12 }, () => scheduleAutoUpdate(f.cli, f.env, now)));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, stdio: 'ignore' });
    await runAutoUpdate(f.cli, { ...f.env, SURPLUS_TEST_FAIL: '1' });
    expect(JSON.parse(await readFile(f.state, 'utf8')).outcome).toBe('failed');
    await scheduleAutoUpdate(f.cli, f.env, new Date(now.getTime() + updateIntervalMs - 1));
    expect(spawn).toHaveBeenCalledTimes(1);
    await scheduleAutoUpdate(f.cli, f.env, new Date(now.getTime() + updateIntervalMs));
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('updates only the owning global prefix and records the verified version and update time', async () => {
    const f = await fixture();
    await writeFile(f.state, JSON.stringify({ lastCheckedAt: new Date().toISOString() }));
    await runAutoUpdate(f.cli, f.env);
    const state = JSON.parse(await readFile(f.state, 'utf8'));
    expect(state).toMatchObject({ outcome: 'updated', installedVersion: '1.1.0' });
    expect(Number.isFinite(Date.parse(state.lastUpdatedAt))).toBe(true);
    expect(JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8')).version).toBe('1.1.0');
    const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['install', '--global', '--prefix', f.prefix, 'surplus-cli@1.1.0',
      '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', '--fetch-retries=0']);
  });

  it('skips installation when current and preserves the last successful update timestamp', async () => {
    const f = await fixture();
    const lastUpdatedAt = '2026-10-08T12:00:00Z';
    await writeFile(f.state, JSON.stringify({ lastCheckedAt: new Date().toISOString(), lastUpdatedAt }));
    await runAutoUpdate(f.cli, { ...f.env, SURPLUS_TEST_LATEST: '1.0.0' });
    expect(JSON.parse(await readFile(f.state, 'utf8'))).toMatchObject({ outcome: 'current', lastUpdatedAt });
    expect((await readFile(f.log, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('does not schedule updates for source checkouts or when disabled', async () => {
    const f = await fixture();
    const spawn = vi.mocked(childProcess.spawn);
    await scheduleAutoUpdate(join(process.cwd(), 'src/cli.ts'), f.env);
    await scheduleAutoUpdate(f.cli, { ...f.env, SURPLUS_AUTO_UPDATE: '0' });
    expect(spawn).not.toHaveBeenCalled();
    await expect(readFile(f.state, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['1.0.1', '1.0.0', true], ['1.10.0', '1.9.0', true], ['1.0.0', '1.0.0', false],
    ['1.0.0', '2.0.0-beta.1', false], ['2.0.0', '2.0.0-beta.1', true],
    ['2.0.0-beta.2', '1.0.0', false], ['bad', '1.0.0', false],
  ])('compares stable release %s against %s', (latest, installed, expected) => {
    expect(isNewerRelease(latest, installed)).toBe(expected);
  });
});
