import type { Decision, ProviderConfig } from './types.js';

export type NoticeState = 'premium' | 'run-out' | 'none';

/**
 * Purely formats minutes as days with one decimal at 1440 or above, rounded hours at 60 or above, or rounded minutes with a minimum of one.
 */
export const formatDuration = (minutes: number): string => {
  if (minutes >= 1440) return `${(minutes / 1440).toFixed(1)}d`;
  if (minutes >= 60) return `${String(Math.round(minutes / 60))}h`;
  return `${String(Math.max(1, Math.round(minutes)))}m`;
};

/**
 * Purely classifies a decision for notices, giving premium precedence over a projected run-out and returning none otherwise.
 */
export const noticeState = (decision: Decision): NoticeState => {
  if (decision.tier === 'premium') return 'premium';
  if (decision.pace?.runsOutBeforeResetMinutes !== undefined) return 'run-out';
  return 'none';
};

const premiumLabel = (decision: Decision): string =>
  decision.model === 'auto' ? `${decision.effort ?? 'higher'} effort` : decision.model;

/**
 * Purely checks whether routing already selected premium or the session model contains the configured premium model, ignoring case.
 * Without routedPremium, missing session models and auto model selections are treated as inactive.
 */
const isActive = (decision: Decision, config: ProviderConfig, sessionModel: string | undefined, routedPremium: boolean): boolean => {
  if (routedPremium) return true;
  if (!sessionModel || decision.model === 'auto' || config.premiumModel === 'auto') return false;
  return sessionModel.toLowerCase().includes(config.premiumModel.toLowerCase());
};

const switchHint = (decision: Decision): string =>
  decision.model === 'auto' ? `→ raise effort to ${decision.effort ?? 'high'} (/model)` : `→ /model ${decision.model}`;

/** Returns the pace-based reason only when pace routing, rather than near-reset routing, explains the premium choice. */
const paceReason = (decision: Decision, config: ProviderConfig): string | undefined => {
  const projectedUnused = decision.pace?.projectedUnusedPercent;
  if (config.strategy === 'near-reset' || projectedUnused === undefined || !Number.isFinite(projectedUnused)) return undefined;
  return `on pace to leave ~${String(Math.max(0, Math.round(projectedUnused)))}% unused at reset`;
};

/**
 * Purely returns a premium-window or run-out notice, or undefined when neither applies.
 * The session model and routedPremium flag shape the premium notice: wrapper-routed
 * sessions are told they are starting on the premium choice, already-premium sessions
 * see it marked active, and other sessions receive a manual switch hint.
 */
export const sessionStartMessage = (input: {
  readonly decision: Decision;
  readonly config: ProviderConfig;
  readonly sessionModel?: string;
  readonly routedPremium?: boolean;
}): string | undefined => {
  const { decision, config, sessionModel, routedPremium = false } = input;
  const state = noticeState(decision);
  if (state === 'premium') {
    const left = decision.weeklyRemainingPercent === null ? '' : ` · ${String(Math.round(decision.weeklyRemainingPercent))}% left`;
    const reset = decision.minutesUntilReset === null ? '' : ` · resets in ${formatDuration(decision.minutesUntilReset)}`;
    const reason = paceReason(decision, config);
    const active = isActive(decision, config, sessionModel, routedPremium);
    const choice = routedPremium ? `starting on ${premiumLabel(decision)}` : `premium window open · ${premiumLabel(decision)}`;
    const tail = active && !routedPremium ? '(active)' : routedPremium ? '' : switchHint(decision);
    return `surplus: ${reason ? `${reason} · ` : ''}${choice}${left}${reset}${tail ? ` ${tail}` : ''}`;
  }
  if (state === 'run-out') {
    return `surplus: on pace to run out ~${formatDuration(decision.pace?.runsOutBeforeResetMinutes ?? 0)} before reset; staying on default`;
  }
  return undefined;
};

/**
 * Purely returns a prompt notice only when the state differs from what this session was last told.
 * Returns undefined for unchanged or unremarkable states and for premium already active
 * according to the session model or the routedPremium flag (wrapper-routed sessions).
 */
export const promptSubmitMessage = (input: {
  readonly previous: NoticeState;
  readonly decision: Decision;
  readonly config: ProviderConfig;
  readonly sessionModel?: string;
  readonly routedPremium?: boolean;
}): string | undefined => {
  const { previous, decision, config, sessionModel, routedPremium = false } = input;
  const state = noticeState(decision);
  if (state === previous) return undefined;
  if (state === 'premium') {
    if (isActive(decision, config, sessionModel, routedPremium)) return undefined;
    return `surplus: premium window just opened ${switchHint(decision)}`;
  }
  if (state === 'run-out') {
    return `surplus: pace now says you'll run out ~${formatDuration(decision.pace?.runsOutBeforeResetMinutes ?? 0)} before reset; consider dropping to default`;
  }
  return undefined;
};

/**
 * Purely returns premium details using the configured model and/or a pace warning, or an empty string when neither applies.
 */
export const statuslineSegment = (decision: Decision, config: ProviderConfig): string => {
  const parts: string[] = [];
  if (decision.tier === 'premium') {
    const left = decision.weeklyRemainingPercent === null ? '' : ` ${String(Math.round(decision.weeklyRemainingPercent))}%`;
    const reset = decision.minutesUntilReset === null ? '' : ` ${formatDuration(decision.minutesUntilReset)}`;
    parts.push(`⚡ ${config.premiumModel}${left}${reset}`);
  }
  if (decision.pace?.runsOutBeforeResetMinutes !== undefined) parts.push('⚠ pace');
  return parts.join(' · ');
};

/** Appends the segment to the first line of the chained output; with no output the segment stands alone. */
export const withSegment = (output: string, segment: string): string => {
  if (!segment) return output;
  if (!output) return segment;
  const newline = output.indexOf('\n');
  const first = newline < 0 ? output : output.slice(0, newline);
  const rest = newline < 0 ? '' : output.slice(newline);
  return `${first} · ${segment}${rest}`;
};
