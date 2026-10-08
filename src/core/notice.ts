import type { Decision, ProviderConfig } from './types.js';

export type NoticeState = 'premium' | 'run-out' | 'none';

export const formatDuration = (minutes: number): string => {
  if (minutes >= 1440) return `${(minutes / 1440).toFixed(1)}d`;
  if (minutes >= 60) return `${String(Math.round(minutes / 60))}h`;
  return `${String(Math.max(1, Math.round(minutes)))}m`;
};

export const noticeState = (decision: Decision): NoticeState => {
  if (decision.tier === 'premium') return 'premium';
  if (decision.pace?.runsOutBeforeResetMinutes !== undefined) return 'run-out';
  return 'none';
};

const premiumLabel = (decision: Decision): string =>
  decision.model === 'auto' ? `${decision.effort ?? 'higher'} effort` : decision.model;

const isActive = (decision: Decision, config: ProviderConfig, sessionModel: string | undefined, routedPremium: boolean): boolean => {
  if (routedPremium) return true;
  if (!sessionModel || decision.model === 'auto' || config.premiumModel === 'auto') return false;
  return sessionModel.toLowerCase().includes(config.premiumModel.toLowerCase());
};

const switchHint = (decision: Decision): string =>
  decision.model === 'auto' ? `→ raise effort to ${decision.effort ?? 'high'} (/model)` : `→ /model ${decision.model}`;

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

/** Speak on prompt submit only when the state differs from what this session was last told. */
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
