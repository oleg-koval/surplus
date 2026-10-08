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

/**
 * Purely returns a premium-window or run-out notice, or undefined when neither applies.
 * The session model and routedPremium flag determine whether a premium notice marks the choice active or suggests a switch.
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
    const tail = isActive(decision, config, sessionModel, routedPremium) ? '(active)' : switchHint(decision);
    return `surplus: premium window open · ${premiumLabel(decision)}${left}${reset} ${tail}`;
  }
  if (state === 'run-out') {
    return `surplus: on pace to run out ~${formatDuration(decision.pace?.runsOutBeforeResetMinutes ?? 0)} before reset; staying on default`;
  }
  return undefined;
};

/**
 * Purely returns a prompt notice only when the state differs from what this session was last told.
 * Returns undefined for unchanged or unremarkable states and for premium already active according to the session model or routedPremium flag.
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
