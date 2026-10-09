import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider, UsageSnapshot } from '../core/types.js';
import { findExecutable } from '../core/launch.js';

const runFile = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export const isSimpleHermesLaunch = (args: readonly string[]): boolean => args.length === 0 || (args.length === 1 && args[0] === 'chat');

/** Parses Hermes's documented `usage --json` schema, accepting only subscription windows. */
export const parseHermesUsage = (value: unknown): UsageSnapshot | undefined => {
  if (!record(value) || !timestamp(value.fetched_at) || !Array.isArray(value.windows) || value.unavailable_reason) return undefined;
  const provider: Provider | undefined = value.provider === 'openai-codex' ? 'codex' : value.provider === 'anthropic' ? 'claude' : undefined;
  if (!provider) return undefined;
  const windows = value.windows.filter(record);
  const weekly = windows.find((window) => window.label === 'Weekly');
  const session = windows.find((window) => window.label === 'Session');
  if (!weekly || !percent(weekly.used_percent) || !timestamp(weekly.resets_at)) return undefined;
  if (session && (!percent(session.used_percent) || !timestamp(session.resets_at))) return undefined;
  if (!session && provider === 'claude') return undefined;
  return {
    provider, observedAt: value.fetched_at, weeklyUsedPercent: weekly.used_percent,
    resetsAt: weekly.resets_at, sessionWindow: session ? 'available' : 'absent',
    ...(session ? { sessionUsedPercent: session.used_percent as number, sessionResetsAt: session.resets_at as string } : {}),
    usageAllowed: true, windowMinutes: 10_080,
  };
};

/** Queries Hermes's own active credential without starting an agent or reading its auth files. */
export const discoverHermes = async (env = process.env): Promise<UsageSnapshot | undefined> => {
  const executable = await findExecutable('hermes', env);
  if (!executable) return undefined;
  try {
    const { stdout } = await runFile(executable, ['usage', '--json'], { env, timeout: 8_000, maxBuffer: 64 * 1024 });
    return parseHermesUsage(JSON.parse(stdout) as unknown);
  } catch { return undefined; }
};
