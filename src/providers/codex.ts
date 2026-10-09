import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { UsageSnapshot } from '../core/types.js';
import { findExecutable } from '../core/launch.js';

interface RpcMessage { readonly id?: number | string; readonly result?: unknown; readonly error?: unknown }
interface Window { readonly usedPercent?: unknown; readonly resetsAt?: unknown; readonly windowDurationMins?: unknown }
export interface Model { readonly model?: unknown; readonly isDefault?: unknown; readonly defaultReasoningEffort?: unknown; readonly supportedReasoningEfforts?: readonly { readonly reasoningEffort?: unknown }[] }
export interface CodexDiscovery { readonly usage?: UsageSnapshot; readonly effectiveModel?: string; readonly effectiveEffort?: string; readonly supportedEfforts: readonly string[]; readonly models: readonly Model[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const debug = (message: string): void => { if (process.env.SURPLUS_DEBUG === '1') process.stderr.write(`surplus debug: ${message}\n`); };

const liveChildren = new Set<ReturnType<typeof spawn>>();

/**
 * Attempts to SIGKILL tracked app-server children before a forced process exit.
 * Signals child processes and clears tracking state, ignoring kill errors without waiting for exit.
 */
export const killCodexAppServers = (): void => {
  for (const child of liveChildren) { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
  liveChildren.clear();
};

class AppServer {
  private readonly child;
  private readonly lines;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly pendingMethods = new Map<number, string>();
  private readonly timeout: NodeJS.Timeout;
  private closed = false;

  /**
   * Starts and tracks a Codex app-server process from the supplied executable for metadata requests, with an eight-second close timer.
   * Performs child-process IO; process and stdin errors reject pending requests, while synchronous setup failures propagate.
   */
  constructor(executable: string) {
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    liveChildren.add(this.child);
    this.lines.on('line', (line) => {
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch { return; }
      if (!isRecord(value)) return;
      const message = value as RpcMessage;
      if (typeof message.id !== 'number') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      const method = this.pendingMethods.get(message.id) ?? 'request';
      this.pendingMethods.delete(message.id);
      if (message.error) request.reject(new Error(`Codex app-server ${method} failed.`));
      else request.resolve(message.result);
    });
    this.child.on('error', (error) => { this.rejectPending(error); });
    this.child.stdin.on('error', (error) => { this.rejectPending(error); });
    this.child.on('exit', () => { liveChildren.delete(this.child); this.rejectPending(new Error('Codex app-server exited before replying.')); });
    this.timeout = setTimeout(() => { this.close(); }, 8_000);
    this.timeout.unref();
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.pendingMethods.clear();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed.'));
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.pendingMethods.set(id, method);
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'surplus', title: 'Surplus', version: '0.1.0' } });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  readLimits(): Promise<unknown> { return this.request('account/rateLimits/read', { excludeResetCreditDetails: true }); }
  readAccount(): Promise<unknown> { return this.request('account/read', {}); }
  readConfig(cwd: string): Promise<unknown> { return this.request('config/read', { cwd, includeLayers: false }); }
  readModels(cursor: string | null): Promise<unknown> { return this.request('model/list', { cursor, limit: 100, includeHidden: false }); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    this.rejectPending(new Error('Codex app-server request timed out or completed.'));
    this.lines.close();
    this.child.kill('SIGTERM');
    const hardKill = setTimeout(() => this.child.kill('SIGKILL'), 500);
    hardKill.unref();
  }
}

const extractWindows = (snapshot: unknown): Window[] => {
  if (!isRecord(snapshot)) return [];
  return [snapshot.primary, snapshot.secondary].filter((value): value is Window => isRecord(value));
};

const pickWindow = (snapshot: unknown, minMins: number, maxMins: number): Window | undefined => extractWindows(snapshot)
  .filter((window) => isNumber(window.windowDurationMins) && window.windowDurationMins >= minMins && window.windowDurationMins <= maxMins)
  .sort((left, right) => Number(right.windowDurationMins) - Number(left.windowDurationMins))[0];

export const codexWindows = (snapshot: unknown): { readonly weekly?: Window; readonly session?: Window; readonly sessionWindow: 'available' | 'absent' | 'invalid' } => {
  const weekly = pickWindow(snapshot, 6 * 24 * 60, 8 * 24 * 60);
  const session = pickWindow(snapshot, 4 * 60, 6 * 60);
  const existing = isRecord(snapshot) ? [snapshot.primary, snapshot.secondary].filter((value) => value !== null && value !== undefined) : [];
  const absent = Boolean(weekly && !session && existing.length === 1);
  return { ...(weekly ? { weekly } : {}), ...(session ? { session } : {}), sessionWindow: session ? 'available' : absent ? 'absent' : 'invalid' };
};

export const codexLimitSnapshot = (limits: unknown): unknown => {
  if (!isRecord(limits)) return undefined;
  if (isRecord(limits.rateLimitsByLimitId)) return limits.rateLimitsByLimitId.codex;
  const legacy = limits.rateLimits;
  if (!isRecord(legacy)) return undefined;
  return legacy.limitId === undefined || legacy.limitId === null || legacy.limitId === 'codex' ? legacy : undefined;
};

const modelPage = (value: unknown): { readonly models: readonly Model[]; readonly nextCursor?: string } => {
  if (!isRecord(value) || !Array.isArray(value.data)) return { models: [] };
  const nextCursor = typeof value.nextCursor === 'string' ? value.nextCursor : undefined;
  return nextCursor === undefined ? { models: value.data as Model[] } : { models: value.data as Model[], nextCursor };
};

export const selectEffectiveCodexModel = (configuredModel: unknown, models: readonly Model[]): Model | undefined => {
  if (typeof configuredModel === 'string') return models.find((model) => model.model === configuredModel);
  return models.find((model) => model.isDefault === true && typeof model.model === 'string');
};

/**
 * Probes Codex for included usage and model capabilities, stamping usage with now; returns undefined for missing executables, non-ChatGPT accounts, or caught lookup or discovery failures, and may return metadata without usage.
 * Resolves `SURPLUS_CODEX_BIN` or searches `PATH` (Node's default POSIX path when unset) while excluding managed wrappers, then starts and closes an app-server child and performs IO; model-catalog failures retain any usage and catalog entries already obtained.
 * Synchronous server setup or cleanup failures reject rather than becoming an undefined result.
 */
export const discoverCodex = async (now = new Date()): Promise<CodexDiscovery | undefined> => {
  let executable: string | undefined;
  try {
    executable = await findExecutable('codex', process.env);
  } catch (error) {
    debug(error instanceof Error ? error.message : 'Codex executable lookup failed.');
    return undefined;
  }
  if (!executable) { debug('Could not find the original Codex executable.'); return undefined; }
  const server = new AppServer(executable);
  try {
    await server.initialize();
    const account = await server.readAccount();
    if (!isRecord(account) || !isRecord(account.account) || account.account.type !== 'chatgpt') { debug('Codex account/read did not report a ChatGPT account.'); return undefined; }
    const rawLimits = await server.readLimits();
    const limits = isRecord(rawLimits) ? rawLimits : undefined;
    const snapshot = codexLimitSnapshot(limits);
    const { weekly: window, session: sessionWindow, sessionWindow: sessionStatus } = codexWindows(snapshot);
    let usage: UsageSnapshot | undefined;
    if (limits && window && isNumber(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 && isNumber(window.resetsAt)
      && (sessionStatus === 'absent' || (sessionWindow && isNumber(sessionWindow.usedPercent) && sessionWindow.usedPercent >= 0 && sessionWindow.usedPercent <= 100 && isNumber(sessionWindow.resetsAt)))) {
      const iso = (seconds: number): string | undefined => {
        const milliseconds = seconds * 1000;
        if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return undefined;
        return new Date(milliseconds).toISOString();
      };
      const resetsAt = iso(window.resetsAt);
      const sessionResetsAt = sessionWindow ? iso(sessionWindow.resetsAt as number) : undefined;
      if (resetsAt && (sessionStatus === 'absent' || sessionResetsAt)) {
        usage = {
          provider: 'codex', observedAt: now.toISOString(), weeklyUsedPercent: window.usedPercent,
          resetsAt, sessionWindow: sessionStatus,
          ...(sessionWindow && sessionResetsAt ? { sessionUsedPercent: sessionWindow.usedPercent as number, sessionResetsAt } : {}),
          usageAllowed: typeof limits.ordinaryUsageAllowed === 'boolean' ? limits.ordinaryUsageAllowed : null,
          ...(isNumber(window.windowDurationMins) ? { windowMinutes: window.windowDurationMins } : {}),
        };
      }
    }
    if (!usage) {
      const durations = extractWindows(snapshot).map((item) => typeof item.windowDurationMins === 'number' ? String(item.windowDurationMins) : 'unknown');
      const legacy = limits ? extractWindows(limits.rateLimits).map((item) => typeof item.windowDurationMins === 'number' ? String(item.windowDurationMins) : 'unknown') : [];
      const bucketIds = limits && isRecord(limits.rateLimitsByLimitId) ? Object.keys(limits.rateLimitsByLimitId).join(',') : 'none';
      const allowed = limits?.ordinaryUsageAllowed;
      const allowedText = typeof allowed === 'boolean' ? String(allowed) : allowed === null || allowed === undefined ? 'unknown' : 'invalid';
      debug(`Codex usage window metadata is incomplete (codex bucket: ${durations.join(',') || 'none'}; legacy: ${legacy.join(',') || 'none'}; buckets: ${bucketIds}; ordinary usage allowed: ${allowedText}; session: ${sessionStatus}).`);
    }
    const effectiveConfig = await server.readConfig(process.cwd());
    const config = isRecord(effectiveConfig) && isRecord(effectiveConfig.config) ? effectiveConfig.config : undefined;
    const configuredModel = typeof config?.model === 'string' ? config.model : undefined;
    const configuredEffort = typeof config?.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined;
    const models: Model[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 20; page += 1) {
        const response = await server.readModels(cursor);
        const result = modelPage(response);
        models.push(...result.models);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
    } catch { /* Rate-limit telemetry remains useful when model catalog data is unavailable. */ }
    const currentModel = selectEffectiveCodexModel(configuredModel, models);
    const effectiveModel = typeof currentModel?.model === 'string' ? currentModel.model : undefined;
    const effectiveEffort = configuredEffort ?? (typeof currentModel?.defaultReasoningEffort === 'string' ? currentModel.defaultReasoningEffort : undefined);
    const supportedEfforts = (currentModel?.supportedReasoningEfforts ?? [])
      .map((entry) => entry.reasoningEffort).filter((effort): effort is string => typeof effort === 'string');
    return {
      ...(usage ? { usage } : {}),
      ...(effectiveModel ? { effectiveModel } : {}),
      ...(effectiveEffort ? { effectiveEffort } : {}),
      supportedEfforts,
      models,
    };
  } catch (error) {
    debug(error instanceof Error ? error.message : 'Codex metadata read failed.');
    return undefined;
  } finally { server.close(); }
};
