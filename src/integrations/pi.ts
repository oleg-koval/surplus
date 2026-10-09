import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Provider } from '../core/types.js';
import { findExecutable } from '../core/launch.js';
import { resolveHomeDirectory } from '../core/xdg.js';

const runFile = promisify(execFile);

/** A project settings file can override the global provider after Pi's trust prompt, so routing skips it. */
export const readPiSource = async (env = process.env, cwd = process.cwd()): Promise<Provider | undefined> => {
  try { await readFile(join(cwd, '.pi', 'settings.json')); return undefined; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  const home = resolveHomeDirectory(env);
  const agentDir = env.PI_CODING_AGENT_DIR
    ? (isAbsolute(env.PI_CODING_AGENT_DIR) ? env.PI_CODING_AGENT_DIR : resolve(cwd, env.PI_CODING_AGENT_DIR))
    : join(home, '.pi', 'agent');
  try {
    const settings: unknown = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as unknown;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined;
    const source = (settings as Record<string, unknown>).defaultProvider;
    return source === 'anthropic' ? 'claude' : source === 'openai-codex' ? 'codex' : undefined;
  } catch { return undefined; }
};

/** Only a fresh interactive chat without options is eligible; explicit Pi choices stay untouched. */
export const isSimplePiLaunch = (args: readonly string[]): boolean => args.length === 0;

/** Checks Pi's effective credential type without reading or printing credential material. */
export const hasPiSubscriptionAuth = async (source: Provider, env = process.env): Promise<boolean> => {
  const executable = await findExecutable('pi', env);
  if (!executable) return false;
  const provider = source === 'claude' ? 'anthropic' : 'openai-codex';
  try {
    const { stdout } = await runFile(executable, ['auth', 'check', '--provider', provider, '--json', '--no-refresh'], {
      env, timeout: 5_000, maxBuffer: 16 * 1024,
    });
    const result: unknown = JSON.parse(stdout) as unknown;
    return typeof result === 'object' && result !== null && !Array.isArray(result)
      && (result as Record<string, unknown>).status === 'ready'
      && (result as Record<string, unknown>).provider === provider
      && (result as Record<string, unknown>).authType === 'oauth';
  } catch { return false; }
};
