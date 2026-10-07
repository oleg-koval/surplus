import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Provider, ProviderConfig, ProviderState, SurplusConfig, UsageSnapshot } from './types.js';

export const dataDir = (): string => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'surplus');
export const configPath = (): string => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'surplus', 'config.json');
const usagePath = (provider: Provider): string => join(dataDir(), `${provider}-usage.json`);
const statePath = (provider: Provider): string => join(dataDir(), `${provider}-state.json`);
const claudeIdentityPath = (): string => join(dataDir(), 'claude-identity.json');
const activationPath = (): string => join(dataDir(), 'activations.json');

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return undefined; }
};

export const atomicJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const isProviderConfig = (value: unknown): value is ProviderConfig => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.premiumModel === 'string'
    && typeof row.minWeeklyRemainingPercent === 'number' && row.minWeeklyRemainingPercent >= 0 && row.minWeeklyRemainingPercent <= 100
    && typeof row.reservePercent === 'number' && row.reservePercent >= 0 && row.reservePercent <= 100
    && typeof row.expectedUsageUntilResetPercent === 'number' && row.expectedUsageUntilResetPercent >= 0 && row.expectedUsageUntilResetPercent <= 100
    && typeof row.minSessionRemainingPercent === 'number' && row.minSessionRemainingPercent >= 0 && row.minSessionRemainingPercent <= 100
    && typeof row.nearResetMinutes === 'number' && row.nearResetMinutes >= 0
    && typeof row.maxTelemetryAgeMinutes === 'number' && row.maxTelemetryAgeMinutes > 0
    && typeof row.hysteresisPercent === 'number' && row.hysteresisPercent >= 0 && row.hysteresisPercent <= row.minWeeklyRemainingPercent
    && (row.premiumEffort === undefined || typeof row.premiumEffort === 'string');
};

const isSurplusConfig = (value: unknown): value is SurplusConfig => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.providers !== 'object' || row.providers === null) return false;
  const providers = row.providers as Record<string, unknown>;
  return isProviderConfig(providers.claude) && isProviderConfig(providers.codex);
};

export const readConfig = async (): Promise<SurplusConfig> => {
  let source: string;
  try { source = await readFile(configPath(), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig;
    throw error;
  }
  let saved: unknown;
  try { saved = JSON.parse(source) as unknown; } catch { throw new Error('Surplus config is malformed; automatic selection is disabled until it is fixed.'); }
  if (!isSurplusConfig(saved)) throw new Error('Surplus config is invalid; automatic selection is disabled until it is fixed.');
  return saved;
};

export const saveConfig = (config: SurplusConfig): Promise<void> => atomicJson(configPath(), config);
export const saveUsage = (usage: UsageSnapshot): Promise<void> => atomicJson(usagePath(usage.provider), usage);
export const readUsage = (provider: Provider): Promise<UsageSnapshot | undefined> => readJson<UsageSnapshot>(usagePath(provider));
export const readState = (provider: Provider): Promise<ProviderState | undefined> => readJson<ProviderState>(statePath(provider));
export const saveState = (provider: Provider, state: ProviderState): Promise<void> => atomicJson(statePath(provider), state);
export const readClaudeIdentity = async (): Promise<string | undefined> => (await readJson<{ identityHash?: string }>(claudeIdentityPath()))?.identityHash;
export const saveClaudeIdentity = (identityHash: string | undefined): Promise<void> => atomicJson(claudeIdentityPath(), { identityHash });
export const incrementActivations = async (): Promise<void> => {
  const record = await readJson<{ count?: number }>(activationPath());
  await atomicJson(activationPath(), { count: (typeof record?.count === 'number' ? record.count : 0) + 1, lastLaunchAt: new Date().toISOString() });
};
export const readActivations = (): Promise<{ count?: number; lastLaunchAt?: string } | undefined> => readJson(activationPath());

export const defaultConfig: SurplusConfig = {
  version: 1,
  providers: {
    claude: {
      premiumModel: 'opus', minWeeklyRemainingPercent: 25,
      reservePercent: 5, expectedUsageUntilResetPercent: 5, minSessionRemainingPercent: 25, nearResetMinutes: 2880,
      maxTelemetryAgeMinutes: 120, hysteresisPercent: 5,
    },
    codex: {
      premiumModel: 'auto', premiumEffort: 'high',
      minWeeklyRemainingPercent: 25, reservePercent: 5, expectedUsageUntilResetPercent: 5,
      minSessionRemainingPercent: 25,
      nearResetMinutes: 2880, maxTelemetryAgeMinutes: 5, hysteresisPercent: 5,
    },
  },
};
