import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import type { UsageSnapshot } from '../core/types.js';
import { managedWrapperContents } from '../core/managed-wrapper.js';
import { surplusDataDirectory } from '../core/xdg.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const numberValue = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const parseClaudeStatusLine = (payload: unknown, now = new Date()): UsageSnapshot | undefined => {
  if (!isRecord(payload) || !isRecord(payload.rate_limits) || !isRecord(payload.rate_limits.seven_day) || !isRecord(payload.rate_limits.five_hour)) return undefined;
  const used = numberValue(payload.rate_limits.seven_day.used_percentage);
  const resetsAt = numberValue(payload.rate_limits.seven_day.resets_at);
  const sessionUsed = numberValue(payload.rate_limits.five_hour.used_percentage);
  const sessionResetsAt = numberValue(payload.rate_limits.five_hour.resets_at);
  if (used === undefined || resetsAt === undefined || sessionUsed === undefined || sessionResetsAt === undefined || used < 0 || used > 100 || sessionUsed < 0 || sessionUsed > 100) return undefined;
  const weeklyResetMs = resetsAt * 1000;
  const sessionResetMs = sessionResetsAt * 1000;
  if (!Number.isFinite(weeklyResetMs) || Math.abs(weeklyResetMs) > 8.64e15 || !Number.isFinite(sessionResetMs) || Math.abs(sessionResetMs) > 8.64e15) return undefined;
  return {
    provider: 'claude', observedAt: now.toISOString(), weeklyUsedPercent: used, sessionWindow: 'available',
    resetsAt: new Date(resetsAt * 1000).toISOString(), sessionUsedPercent: sessionUsed,
    sessionResetsAt: new Date(sessionResetsAt * 1000).toISOString(), usageAllowed: true,
  };
};

export const readStatusLineInput = async (): Promise<unknown> => {
  let input = '';
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) input += `${line}\n`;
  try { return JSON.parse(input) as unknown; } catch { return undefined; }
};

export const readClaudeIdentityHash = (env = process.env): string | undefined => {
  const configuredBin = env.SURPLUS_CLAUDE_BIN;
  let wrapperDir: string;
  try { wrapperDir = join(surplusDataDirectory(env), 'bin'); } catch { return undefined; }
  const canonicalPath = (path: string): string => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const isManagedWrapper = (path: string): boolean => {
    try {
      const details = statSync(path);
      const contents = managedWrapperContents('claude');
      return details.isFile() && details.size === Buffer.byteLength(contents) && readFileSync(path, 'utf8') === contents;
    } catch { return false; }
  };
  const managedExecutable = canonicalPath(join(wrapperDir, 'claude'));
  if (configuredBin && (canonicalPath(configuredBin) === managedExecutable || isManagedWrapper(configuredBin))) return undefined;
  const canonicalWrapperDir = canonicalPath(wrapperDir);
  const executable = configuredBin ?? (env.PATH === undefined ? [] : env.PATH.split(delimiter)).map((directory) => directory || '.').filter((directory) => canonicalPath(directory) !== canonicalWrapperDir).map((directory) => resolve(directory, 'claude')).find((path) => {
    try {
      if (!statSync(path).isFile()) return false;
      if (canonicalPath(path) === managedExecutable || isManagedWrapper(path)) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch { return false; }
  });
  if (!executable) return undefined;
  const result = spawnSync(executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 2_000, env });
  if (result.status !== 0 || result.error) return undefined;
  try {
    const value: unknown = JSON.parse(result.stdout) as unknown;
    if (!isRecord(value) || value.loggedIn !== true || value.authMethod !== 'claude.ai' || value.apiProvider !== 'firstParty') return undefined;
    if (typeof value.email !== 'string' || typeof value.orgId !== 'string' || typeof value.subscriptionType !== 'string') return undefined;
    return createHash('sha256').update(`${value.email.toLowerCase()}\n${value.orgId}\n${value.subscriptionType}`).digest('hex');
  } catch { return undefined; }
};
