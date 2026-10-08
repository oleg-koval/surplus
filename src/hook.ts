import type { Decision, Provider, ProviderConfig, UsageSnapshot } from './core/types.js';
import { decide } from './core/policy.js';
import { codexUpgradeConfig } from './core/codex-policy.js';
import { noticeState, promptSubmitMessage, sessionStartMessage } from './core/notice.js';
import { readClaudeIdentity, readConfig, readHookSessions, readState, readUsage, readUsageHistory, saveHookSession, saveUsage } from './core/files.js';
import { discoverCodex } from './providers/codex.js';
import type { CodexDiscovery } from './providers/codex.js';

export type HookEvent = 'session-start' | 'prompt-submit';
export const hookBudgetMs = 3_000;
const codexRefreshThrottleMs = 10 * 60_000;

export interface HookDeps {
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly discover?: () => Promise<CodexDiscovery | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const decideFor = async (provider: Provider, config: ProviderConfig, discovery: CodexDiscovery | undefined, usage: UsageSnapshot | undefined, now: Date): Promise<{ readonly decision: Decision; readonly config: ProviderConfig }> => {
  const previous = await readState(provider);
  const history = await readUsageHistory(provider);
  const effective = provider === 'codex' ? codexUpgradeConfig(config, discovery) : config;
  return { decision: decide({ ...(usage ? { usage } : {}), config: effective, ...(previous ? { previous } : {}), history, now }), config: effective };
};

/** Returns the one-line message for the hook, or undefined to stay silent. Throws only on unexpected failures; the caller prints nothing then. */
export const hookMessage = async (provider: Provider, event: HookEvent, input: unknown, deps: HookDeps = {}): Promise<string | undefined> => {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const config = await readConfig();
  const enabled = event === 'session-start' ? config.features.sessionNotice : config.features.promptNudge;
  if (!enabled) return undefined;
  const body = isRecord(input) ? input : {};
  const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : undefined;
  const sessionModel = typeof body.model === 'string' ? body.model : undefined;
  const sessions = event === 'prompt-submit' ? await readHookSessions() : {};
  const prior = sessionId ? sessions[sessionId] : undefined;

  let usage: UsageSnapshot | undefined;
  let discovery: CodexDiscovery | undefined;
  if (provider === 'claude') {
    const identity = env.SURPLUS_CLAUDE_IDENTITY_HASH ?? await readClaudeIdentity();
    const cached = await readUsage('claude');
    if (identity && cached?.identityHash === identity) usage = cached;
  } else {
    if (prior && now.getTime() - Date.parse(prior.checkedAt) < codexRefreshThrottleMs) return undefined;
    discovery = await (deps.discover ?? (() => discoverCodex(now)))();
    usage = discovery?.usage;
    if (usage) { try { await saveUsage(usage); } catch { /* Cache write is best-effort. */ } }
  }

  const { decision, config: effective } = await decideFor(provider, config.providers[provider], discovery, usage, now);
  const state = noticeState(decision);
  const routedPremium = env.SURPLUS_ROUTED_TIER === 'premium';
  const message = event === 'session-start'
    ? sessionStartMessage({ decision, config: effective, ...(sessionModel ? { sessionModel } : {}), routedPremium })
    : promptSubmitMessage({ previous: (prior?.state as 'premium' | 'run-out' | 'none' | undefined) ?? 'none', decision, config: effective, ...(sessionModel ? { sessionModel } : {}), routedPremium });
  if (sessionId) {
    try { await saveHookSession(sessionId, { state, checkedAt: now.toISOString() }, now); } catch { /* Per-session memory is best-effort. */ }
  }
  return message;
};

/** Reads hook JSON from stdin and resolves to stdout text within the hard budget; never rejects. */
export const runHook = async (provider: Provider, event: HookEvent, readInput: () => Promise<unknown>, deps: HookDeps = {}): Promise<string> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, hookBudgetMs); });
  try {
    const work = (async (): Promise<string | undefined> => {
      const input = await readInput();
      return hookMessage(provider, event, input, deps);
    })();
    work.catch(() => undefined);
    const message = await Promise.race([work, deadline]);
    return message ? `${JSON.stringify({ systemMessage: message })}\n` : '';
  } catch { return ''; } finally { clearTimeout(timer); }
};
