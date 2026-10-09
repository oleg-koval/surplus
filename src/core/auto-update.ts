import { execFile, spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { atomicJson, withFileLock } from './files.js';
import { findExecutable } from './launch.js';
import { surplusDataDirectory } from './xdg.js';

const execute = promisify(execFile);
export const updateIntervalMs = 6 * 60 * 60_000;
interface Installation { root: string; prefix: string; version: string }
interface UpdateState {
  lastCheckedAt: string;
  lastUpdatedAt?: string;
  installedVersion?: string;
  outcome?: 'checking' | 'current' | 'updated' | 'failed';
}

const metadata = async (root: string): Promise<{ name?: string; version?: string }> =>
  JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };

const globalInstallation = async (cliPath: string): Promise<Installation | undefined> => {
  const root = dirname(dirname(await realpath(cliPath)));
  const modules = dirname(root);
  const lib = dirname(modules);
  if (basename(root) !== 'surplus-cli' || basename(modules) !== 'node_modules' || basename(lib) !== 'lib') return undefined;
  const pkg = await metadata(root);
  if (pkg.name !== 'surplus-cli' || typeof pkg.version !== 'string') return undefined;
  return { root, prefix: dirname(lib), version: pkg.version };
};

const readState = async (path: string): Promise<UpdateState | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value !== 'object' || value === null || !('lastCheckedAt' in value) || typeof value.lastCheckedAt !== 'string') return undefined;
    return value as UpdateState;
  } catch { return undefined; }
};

/** Compares a stable registry release with the installed version without downgrading prereleases. */
export const isNewerRelease = (latest: string, installed: string): boolean => {
  const release = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest);
  const current = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(installed);
  if (!release || !current) return false;
  for (let index = 1; index <= 3; index += 1) {
    const left = Number(release[index]);
    const right = Number(current[index]);
    if (left !== right) return left > right;
  }
  return Boolean(current[4]);
};

/** Reserves one update attempt per six hours and starts a detached, silent worker. */
export const scheduleAutoUpdate = async (cliPath: string, env = process.env, now = new Date()): Promise<void> => {
  if (env.SURPLUS_AUTO_UPDATE === '0' || process.platform === 'win32') return;
  try {
    if (!await globalInstallation(cliPath)) return;
    const path = join(surplusDataDirectory(env), 'auto-update.json');
    await withFileLock(path, async () => {
      const state = await readState(path);
      const checked = state ? Date.parse(state.lastCheckedAt) : Number.NaN;
      if (Number.isFinite(checked) && now.getTime() - checked < updateIntervalMs) return;
      // Reserve before starting any network IO; failures also retain this cooldown.
      await atomicJson(path, { ...state, lastCheckedAt: now.toISOString(), outcome: 'checking' });
      const child = spawn(process.execPath, [cliPath, '--internal-auto-update'], {
        env, detached: true, stdio: 'ignore',
      });
      child.once('error', () => { /* Keep the cooldown when a worker cannot start. */ });
      child.unref();
    });
  } catch { /* Updates must not affect provider launches, hooks, or command output. */ }
};

/** Checks npm's stable release and updates only this global installation; all failures are silent. */
export const runAutoUpdate = async (cliPath: string, env = process.env): Promise<void> => {
  if (env.SURPLUS_AUTO_UPDATE === '0' || process.platform === 'win32') return;
  let path: string | undefined;
  let outcome: UpdateState['outcome'] = 'failed';
  let installedVersion: string | undefined;
  try {
    const installation = await globalInstallation(cliPath);
    if (!installation) return;
    path = join(surplusDataDirectory(env), 'auto-update.json');
    const npm = await findExecutable('npm', env);
    if (!npm) throw new Error('npm is unavailable.');
    const options = { env, maxBuffer: 64 * 1024, timeout: 15_000 };
    const result = await execute(npm, ['view', 'surplus-cli', 'dist-tags.latest', '--json', '--fetch-retries=0'], options);
    const latest: unknown = JSON.parse(result.stdout);
    if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('Invalid npm release metadata.');
    outcome = 'current';
    if (isNewerRelease(latest, installation.version)) {
      outcome = 'failed';
      await execute(npm, ['install', '--global', '--prefix', installation.prefix, `surplus-cli@${latest}`,
        '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', '--fetch-retries=0'], { ...options, timeout: 120_000 });
      const updated = await metadata(installation.root);
      if (updated.name !== 'surplus-cli' || updated.version !== latest) throw new Error('Installed version did not match the release.');
      installedVersion = latest;
      outcome = 'updated';
    }
  } catch { /* Record the failed attempt without printing npm output or retrying. */ }
  if (path) {
    try {
      await withFileLock(path, async () => {
        const state = await readState(path);
        if (!state) return;
        await atomicJson(path, { ...state, outcome,
          ...(installedVersion ? { installedVersion, lastUpdatedAt: new Date().toISOString() } : {}),
        });
      });
    } catch { /* Update reporting is best effort and cannot affect CLI exit status. */ }
  }
};
