import { chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Features, Integration, IntegrationConfig, Provider, ProviderConfig, ProviderState, SurplusConfig, UsageSample, UsageSnapshot, WorkloadForecast } from './types.js';
import { surplusDataDirectory, xdgDirectory } from './xdg.js';

export const dataDir = (): string => surplusDataDirectory();
export const configPath = (): string => join(xdgDirectory('config'), 'surplus', 'config.json');
export const integrationsPath = (): string => join(xdgDirectory('config'), 'surplus', 'integrations.json');
const usagePath = (provider: Provider): string => join(dataDir(), `${provider}-usage.json`);
const statePath = (provider: Provider): string => join(dataDir(), `${provider}-state.json`);
const historyPath = (provider: Provider): string => join(dataDir(), `${provider}-usage-history.json`);
const forecastPath = (provider: Provider): string => join(dataDir(), `${provider}-forecast.json`);
const hookSessionsPath = (): string => join(dataDir(), 'hook-sessions.json');
const claudeIdentityPath = (): string => join(dataDir(), 'claude-identity.json');

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return undefined; }
};

export const atomicJson = async (path: string, value: unknown): Promise<void> => {
  let destination = path;
  let isSymlink = false;
  try {
    isSymlink = (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (isSymlink) destination = await realpath(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
};

export const withFileLock = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 100;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lockPath)).mtimeMs > 10_000) await unlink(lockPath); } catch { /* A concurrent release may remove it. */ }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Surplus data lock.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
};

/**
 * Purely checks required routing settings and optional pace settings against their accepted values and bounds.
 */
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
    && (row.premiumEffort === undefined || typeof row.premiumEffort === 'string')
    && (row.strategy === undefined || row.strategy === 'pace' || row.strategy === 'near-reset')
    && (row.premiumBurnMultiplier === undefined || (typeof row.premiumBurnMultiplier === 'number' && row.premiumBurnMultiplier > 0))
    && (row.paceMarginPercent === undefined || (typeof row.paceMarginPercent === 'number' && row.paceMarginPercent >= 0 && row.paceMarginPercent <= 100))
    && (row.minPaceElapsedMinutes === undefined || (typeof row.minPaceElapsedMinutes === 'number' && row.minPaceElapsedMinutes >= 0));
};

/**
 * Purely accepts omitted features or an object whose values are all booleans, including unknown keys.
 */
const isFeatures = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'boolean');
};

/**
 * Purely checks the version, both provider configurations, and optional features without applying defaults.
 */
const isIntegrationConfig = (value: unknown): value is IntegrationConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const validModel = (model: unknown): boolean => typeof model === 'string' && model.length > 0;
  const validEffort = (effort: unknown): boolean => effort === undefined || (typeof effort === 'string' && effort.length > 0);
  const validSource = (source: unknown): boolean => typeof source === 'object' && source !== null && !Array.isArray(source)
    && validModel((source as Record<string, unknown>).premiumModel)
    && validEffort((source as Record<string, unknown>).premiumEffort);
  const sources = row.sources;
  return (row.premiumModel === undefined || validModel(row.premiumModel)) && validEffort(row.premiumEffort)
    && (sources === undefined || (typeof sources === 'object' && sources !== null && !Array.isArray(sources)
      && Object.entries(sources).every(([key, source]) => (key === 'claude' || key === 'codex') && validSource(source))));
};

const isIntegrations = (value: unknown): value is Partial<Record<Integration, IntegrationConfig>> => {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.hermes === undefined || isIntegrationConfig(row.hermes)) && (row.pi === undefined || isIntegrationConfig(row.pi));
};

const isSurplusConfig = (value: unknown): value is { readonly version: 1; readonly providers: Record<Provider, ProviderConfig>; readonly integrations?: Partial<Record<Integration, IntegrationConfig>>; readonly features?: Partial<Features> } => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.providers !== 'object' || row.providers === null) return false;
  const providers = row.providers as Record<string, unknown>;
  return isProviderConfig(providers.claude) && isProviderConfig(providers.codex) && isFeatures(row.features) && isIntegrations(row.integrations);
};

/**
 * Purely returns a copy of saved settings with missing pace options filled from the provider defaults.
 */
const withPaceDefaults = (provider: Provider, saved: ProviderConfig): ProviderConfig => {
  const defaults = defaultConfig.providers[provider];
  return {
    ...saved,
    strategy: saved.strategy ?? defaults.strategy ?? 'pace',
    premiumBurnMultiplier: saved.premiumBurnMultiplier ?? defaults.premiumBurnMultiplier ?? 1.5,
    paceMarginPercent: saved.paceMarginPercent ?? defaults.paceMarginPercent ?? 10,
    minPaceElapsedMinutes: saved.minPaceElapsedMinutes ?? defaults.minPaceElapsedMinutes ?? 1440,
  };
};

/**
 * Reads the local config and returns validated settings with pace and feature defaults, or all defaults when the file is missing.
 * Performs filesystem IO and rejects on invalid home-directory configuration, other read failures, malformed JSON, or invalid settings.
 */
const readIntegrations = async (fallback: Partial<Record<Integration, IntegrationConfig>> = {}): Promise<SurplusConfig['integrations']> => {
  let source: string;
  try { source = await readFile(integrationsPath(), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultConfig.integrations, ...fallback };
    throw error;
  }
  let saved: unknown;
  try { saved = JSON.parse(source) as unknown; } catch { throw new Error('Surplus integration config is malformed; automatic selection is disabled until it is fixed.'); }
  if (!isIntegrations(saved)) throw new Error('Surplus integration config is invalid; automatic selection is disabled until it is fixed.');
  return { ...defaultConfig.integrations, ...saved };
};

export const readConfig = async (): Promise<SurplusConfig> => {
  let source: string | undefined;
  try { source = await readFile(configPath(), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (source === undefined) return { ...defaultConfig, integrations: await readIntegrations() };
  let saved: unknown;
  try { saved = JSON.parse(source) as unknown; } catch { throw new Error('Surplus config is malformed; automatic selection is disabled until it is fixed.'); }
  if (!isSurplusConfig(saved)) throw new Error('Surplus config is invalid; automatic selection is disabled until it is fixed.');
  return {
    version: 1,
    providers: { claude: withPaceDefaults('claude', saved.providers.claude), codex: withPaceDefaults('codex', saved.providers.codex) },
    integrations: await readIntegrations(saved.integrations),
    features: { ...defaultFeatures, ...saved.features },
  };
};

export const saveConfig = (config: SurplusConfig): Promise<void> => atomicJson(configPath(), config);
export const updateConfig = async (update: (latest: SurplusConfig) => SurplusConfig): Promise<SurplusConfig> => withFileLock(configPath(), async () => {
  const updated = update(await readConfig());
  await saveConfig(updated);
  return updated;
});
export const updateIntegrations = async (update: (latest: SurplusConfig['integrations']) => SurplusConfig['integrations']): Promise<void> => {
  await withFileLock(integrationsPath(), async () => {
    const current = await readConfig();
    await atomicJson(integrationsPath(), update(current.integrations));
  });
};
export const maxHistoryEntries = 300;
export const historyThrottleMinutes = 10;

const isUsageSample = (value: unknown): value is UsageSample => typeof value === 'object' && value !== null
  && typeof (value as UsageSample).observedAt === 'string' && Number.isFinite(Date.parse((value as UsageSample).observedAt))
  && typeof (value as UsageSample).used === 'number' && Number.isFinite((value as UsageSample).used)
  && (value as UsageSample).used >= 0 && (value as UsageSample).used <= 100
  && typeof (value as UsageSample).resetsAt === 'string'
  && ((value as UsageSample).identityHash === undefined || typeof (value as UsageSample).identityHash === 'string');

/**
 * Reads saved history for the provider, retaining entries with valid observation dates, usage percentages, and string reset times; returns an empty array for unreadable, malformed, or non-array data.
 * Performs filesystem IO; invalid home-directory configuration rejects before the read.
 */
export const readUsageHistory = async (provider: Provider): Promise<UsageSample[]> => {
  const saved = await readJson<unknown>(historyPath(provider));
  return Array.isArray(saved) ? saved.filter(isUsageSample) : [];
};

const isWorkloadForecast = (value: unknown): value is WorkloadForecast => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.provider === 'claude' || row.provider === 'codex')
    && typeof row.resetAt === 'string' && Number.isFinite(Date.parse(row.resetAt))
    && typeof row.expectedUsagePercent === 'number' && Number.isFinite(row.expectedUsagePercent)
    && row.expectedUsagePercent >= 0 && row.expectedUsagePercent <= 100
    && (row.source === 'explicit' || row.source === 'history')
    && typeof row.setAt === 'string' && Number.isFinite(Date.parse(row.setAt))
    && (row.provider === 'codex' ? (row.identityHash === undefined || typeof row.identityHash === 'string') : typeof row.identityHash === 'string');
};

/** Reads a valid local forecast, ignoring malformed state so routing can fail safe. */
export const readForecast = (provider: Provider): Promise<WorkloadForecast | undefined> =>
  readJson<unknown>(forecastPath(provider)).then((saved) => isWorkloadForecast(saved) && saved.provider === provider ? saved : undefined);

/** Reads a forecast only when it belongs to the provider's current reset window. */
export const readActiveForecast = async (provider: Provider, resetAt: string): Promise<WorkloadForecast | undefined> => {
  const forecast = await readForecast(provider);
  return forecast?.resetAt === resetAt ? forecast : undefined;
};

/** Atomically persists a validated local workload forecast. */
export const saveForecast = async (forecast: WorkloadForecast): Promise<void> => {
  if (!isWorkloadForecast(forecast)) throw new Error('Workload forecast is invalid.');
  await withFileLock(forecastPath(forecast.provider), async () => atomicJson(forecastPath(forecast.provider), forecast));
};

/** Removes a provider's forecast; absence is already a successful clear. */
export const clearForecast = async (provider: Provider): Promise<void> => {
  await withFileLock(forecastPath(provider), async () => unlink(forecastPath(provider)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }));
};

/**
 * Writes history for the snapshot's reset window, appending when usage changes or at least ten minutes have elapsed and retaining the last 300 entries on append.
 * An invalid observation timestamp leaves history unchanged.
 * Performs filesystem IO and rejects on home-directory or write failures.
 */
const recordUsageHistory = async (usage: UsageSnapshot): Promise<void> => {
  const observed = Date.parse(usage.observedAt);
  if (!Number.isFinite(observed)) return;
  const identityHash = usage.identityHash;
  await withFileLock(historyPath(usage.provider), async () => {
    const saved = await readUsageHistory(usage.provider);
    const current = saved.filter((sample) => sample.resetsAt === usage.resetsAt && sample.identityHash === identityHash);
    const last = current.at(-1);
    const due = last?.used !== usage.weeklyUsedPercent || observed - Date.parse(last.observedAt) >= historyThrottleMinutes * 60_000;
    const next = due ? [...current, { observedAt: usage.observedAt, used: usage.weeklyUsedPercent, resetsAt: usage.resetsAt, ...(identityHash ? { identityHash } : {}) }].slice(-maxHistoryEntries) : current;
    if (!(due || next.length !== saved.length)) return;
    await atomicJson(historyPath(usage.provider), next);
  });
};

/**
 * Writes the provider's latest snapshot and attempts to update its usage history.
 * Performs filesystem IO; snapshot persistence failures reject, while history failures are ignored.
 */
export const saveUsage = async (usage: UsageSnapshot): Promise<void> => {
  await atomicJson(usagePath(usage.provider), usage);
  try { await recordUsageHistory(usage); } catch { /* History only sharpens pace estimates; it never blocks capture. */ }
};

export interface HookSessionRecord { readonly state: string; readonly checkedAt: string }
const sessionRetentionMs = 7 * 24 * 60 * 60_000;

/**
 * Reads session notice records with string state and check-time fields, returning an empty object for unreadable, malformed, or non-object data.
 * Performs filesystem IO; invalid home-directory configuration rejects before the read.
 */
export const readHookSessions = async (): Promise<Record<string, HookSessionRecord>> => {
  const saved = await readJson<unknown>(hookSessionsPath());
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  const result: Record<string, HookSessionRecord> = {};
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value === 'object' && value !== null && typeof (value as HookSessionRecord).state === 'string' && typeof (value as HookSessionRecord).checkedAt === 'string') {
      result[key] = value as HookSessionRecord;
    }
  }
  return result;
};

/**
 * Persists the session's notice record, removing other records with invalid check times or check times more than seven days before now.
 * Performs filesystem IO and rejects on home-directory or write failures.
 */
export const saveHookSession = async (sessionId: string, record: HookSessionRecord, now: Date): Promise<void> => {
  await withFileLock(hookSessionsPath(), async () => {
    const sessions = await readHookSessions();
    const existing = sessions[sessionId];
    const selected = existing && Date.parse(existing.checkedAt) > Date.parse(record.checkedAt) ? existing : record;
    const kept = Object.entries(sessions).filter(([key, value]) => key !== sessionId && now.getTime() - Date.parse(value.checkedAt) <= sessionRetentionMs);
    await atomicJson(hookSessionsPath(), Object.fromEntries([...kept, [sessionId, selected]]));
  });
};
export const readUsage = (provider: Provider): Promise<UsageSnapshot | undefined> => readJson<UsageSnapshot>(usagePath(provider));
export const readState = (provider: Provider): Promise<ProviderState | undefined> => readJson<ProviderState>(statePath(provider));
export const saveState = (provider: Provider, state: ProviderState): Promise<void> => atomicJson(statePath(provider), state);
export const readClaudeIdentity = async (): Promise<string | undefined> => (await readJson<{ identityHash?: string }>(claudeIdentityPath()))?.identityHash;
export const saveClaudeIdentity = (identityHash: string | undefined, now = new Date()): Promise<void> => atomicJson(claudeIdentityPath(), { identityHash, checkedAt: now.toISOString() });
/** Returns the saved identity only when it was resolved within maxAgeMs, so callers can skip spawning `claude auth status`. */
export const readFreshClaudeIdentity = async (maxAgeMs: number, now = new Date()): Promise<string | undefined> => {
  const saved = await readJson<{ identityHash?: string; checkedAt?: string }>(claudeIdentityPath());
  const checked = Date.parse(saved?.checkedAt ?? '');
  return typeof saved?.identityHash === 'string' && Number.isFinite(checked) && now.getTime() - checked <= maxAgeMs ? saved.identityHash : undefined;
};
export const defaultFeatures: Features = { sessionNotice: true, promptNudge: false, statuslineSegment: false };
export const defaultConfig: SurplusConfig = {
  version: 1,
  features: defaultFeatures,
  integrations: { hermes: {}, pi: {} },
  providers: {
    claude: {
      premiumModel: 'opus', minWeeklyRemainingPercent: 25,
      reservePercent: 5, expectedUsageUntilResetPercent: 5, minSessionRemainingPercent: 25, nearResetMinutes: 2880,
      maxTelemetryAgeMinutes: 120, hysteresisPercent: 5,
      strategy: 'pace', premiumBurnMultiplier: 1.5, paceMarginPercent: 10, minPaceElapsedMinutes: 1440,
    },
    codex: {
      premiumModel: 'auto', premiumEffort: 'high',
      minWeeklyRemainingPercent: 25, reservePercent: 5, expectedUsageUntilResetPercent: 5,
      minSessionRemainingPercent: 25,
      nearResetMinutes: 2880, maxTelemetryAgeMinutes: 5, hysteresisPercent: 5,
      strategy: 'pace', premiumBurnMultiplier: 1.3, paceMarginPercent: 10, minPaceElapsedMinutes: 1440,
    },
  },
};
